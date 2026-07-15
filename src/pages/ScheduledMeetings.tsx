import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../store/Auth'
import {
  ApiError,
  adminListSchedules,
  adminListUsers,
  calendarMeetings,
  calendarRemove,
  calendarRestore,
  deleteSchedule,
  normalizeCalendarEvents,
  type AdminSchedule,
  type CalendarEvent,
} from '../lib/api'
import { Icon } from '../components/Icon'
import { groupEvents, MeetingGroupRow, RemovedGroupRow, ScheduleRow } from '../components/scheduleRows'

// Admin-only: every user's upcoming calendar meetings and manually-scheduled
// notetaker runs, in one place. Admin has no calendar of their own, so each
// user's calendar is fetched on demand (acting as that user, via the email
// param the Worker only honors for admin sessions) when their row is expanded.

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready' }

type CalendarState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; events: CalendarEvent[]; cancelled: CalendarEvent[] }

export default function ScheduledMeetings() {
  const { state } = useAuth()
  const isAdmin = state.status === 'authed' && state.isAdmin

  if (!isAdmin) {
    return (
      <div className="grid place-items-center py-[20vh] text-center">
        <Icon name="lock" size={40} className="mb-sm text-outline" />
        <h2 className="text-display-sm text-on-surface">Admins only</h2>
        <p className="mt-1 text-body-md text-secondary">This page is only available to admin accounts.</p>
      </div>
    )
  }

  return <ScheduledMeetingsAdmin />
}

function ScheduledMeetingsAdmin() {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' })
  const [users, setUsers] = useState<string[]>([])
  const [schedulesByUser, setSchedulesByUser] = useState<Map<string, AdminSchedule[]>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [calendars, setCalendars] = useState<Record<string, CalendarState>>({})

  async function loadAll() {
    setLoad({ status: 'loading' })
    try {
      const [userList, schedules] = await Promise.all([adminListUsers(), adminListSchedules()])
      const byUser = new Map<string, AdminSchedule[]>()
      for (const s of schedules) {
        const list = byUser.get(s.owner) || []
        list.push(s)
        byUser.set(s.owner, list)
      }
      setUsers(userList)
      setSchedulesByUser(byUser)
      setLoad({ status: 'ready' })
    } catch (err) {
      setLoad({ status: 'error', message: err instanceof ApiError ? err.message : 'Could not load users.' })
    }
  }

  useEffect(() => {
    void loadAll()
  }, [])

  async function loadCalendarFor(email: string) {
    setCalendars((prev) => ({ ...prev, [email]: { status: 'loading' } }))
    try {
      const { calendar } = await calendarMeetings(true, email)
      const all = normalizeCalendarEvents(calendar)
      setCalendars((prev) => ({
        ...prev,
        [email]: {
          status: 'ready',
          events: all.filter((e) => String(e.status) !== 'cancelled'),
          cancelled: all.filter((e) => String(e.status) === 'cancelled'),
        },
      }))
    } catch (err) {
      setCalendars((prev) => ({
        ...prev,
        [email]: {
          status: 'error',
          message: err instanceof ApiError ? err.message : 'Could not load this user’s calendar.',
        },
      }))
    }
  }

  function toggle(email: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(email)) {
        next.delete(email)
      } else {
        next.add(email)
        if (!calendars[email]) void loadCalendarFor(email)
      }
      return next
    })
  }

  async function removeOne(email: string, id: number | string) {
    await calendarRemove(id, email)
    await loadCalendarFor(email)
  }
  async function removeAll(email: string, ids: (number | string)[]) {
    await Promise.all(ids.map((id) => calendarRemove(id, email)))
    await loadCalendarFor(email)
  }
  async function restoreOne(email: string, id: number | string) {
    await calendarRestore(id, email)
    await loadCalendarFor(email)
  }
  async function restoreAll(email: string, ids: (number | string)[]) {
    await Promise.all(ids.map((id) => calendarRestore(id, email)))
    await loadCalendarFor(email)
  }
  async function cancelSchedule(email: string, id: string) {
    setSchedulesByUser((prev) => {
      const next = new Map(prev)
      next.set(email, (next.get(email) || []).filter((s) => s.id !== id)) // optimistic
      return next
    })
    try {
      await deleteSchedule(id, email)
    } finally {
      await loadAll()
    }
  }

  return (
    <div className="animate-fade-up">
      <header className="mb-lg">
        <h2 className="text-display-lg text-on-background">Scheduled Meetings</h2>
        <p className="mt-1 text-body-md text-secondary">
          Every user's upcoming calendar meetings and scheduled notetaker runs — remove or cancel one on their behalf
          so the bot won't join it.
        </p>
      </header>

      {load.status === 'error' && (
        <div className="mb-gutter grid place-items-center gap-1 rounded-xl border border-dashed border-outline-variant bg-surface-container-low py-lg text-center">
          <Icon name="error" size={26} className="text-outline" />
          <p className="text-metadata text-secondary">{load.message}</p>
        </div>
      )}

      {load.status === 'loading' && (
        <div className="grid place-items-center gap-2 rounded-xl border border-dashed border-outline-variant bg-surface-container-low py-xl text-center">
          <Icon name="event" size={30} className="text-outline motion-safe:animate-pulse" />
          <p className="text-metadata text-secondary">Loading users…</p>
        </div>
      )}

      {load.status === 'ready' && users.length === 0 && (
        <div className="grid place-items-center gap-1 rounded-xl border border-dashed border-outline-variant bg-surface-container-low py-lg text-center">
          <Icon name="event_busy" size={26} className="text-outline" />
          <p className="text-metadata text-secondary">No users with meetings or schedules yet.</p>
        </div>
      )}

      {load.status === 'ready' && users.length > 0 && (
        <ul className="flex flex-col gap-3">
          {users.map((email) => (
            <UserSection
              key={email}
              email={email}
              schedules={schedulesByUser.get(email) || []}
              calendar={calendars[email] || { status: 'idle' }}
              expandedOpen={expanded.has(email)}
              onToggle={() => toggle(email)}
              onRemoveOne={(id) => removeOne(email, id)}
              onRemoveAll={(ids) => removeAll(email, ids)}
              onRestoreOne={(id) => restoreOne(email, id)}
              onRestoreAll={(ids) => restoreAll(email, ids)}
              onCancelSchedule={(id) => cancelSchedule(email, id)}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function UserSection({
  email,
  schedules,
  calendar,
  expandedOpen,
  onToggle,
  onRemoveOne,
  onRemoveAll,
  onRestoreOne,
  onRestoreAll,
  onCancelSchedule,
}: {
  email: string
  schedules: AdminSchedule[]
  calendar: CalendarState
  expandedOpen: boolean
  onToggle: () => void
  onRemoveOne: (id: number | string) => Promise<void>
  onRemoveAll: (ids: (number | string)[]) => Promise<void>
  onRestoreOne: (id: number | string) => Promise<void>
  onRestoreAll: (ids: (number | string)[]) => Promise<void>
  onCancelSchedule: (id: string) => Promise<void>
}) {
  const groups = useMemo(() => (calendar.status === 'ready' ? groupEvents(calendar.events) : []), [calendar])
  const removedGroups = useMemo(() => (calendar.status === 'ready' ? groupEvents(calendar.cancelled) : []), [calendar])
  const upcoming = useMemo(() => [...schedules].sort((a, b) => a.nextRun - b.nextRun), [schedules])

  return (
    <li className="rounded-2xl border border-outline-variant bg-surface-container-lowest shadow-card">
      <button
        type="button"
        onClick={onToggle}
        className="press flex w-full items-center gap-3 px-md py-3.5 text-left"
      >
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary-fixed/60 text-[13px] font-bold text-primary">
          {email.slice(0, 2).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold text-on-surface">{email}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-secondary">
            <span>
              {schedules.length} schedule{schedules.length === 1 ? '' : 's'}
            </span>
            {calendar.status === 'ready' && (
              <span>
                · {groups.length} calendar meeting{groups.length === 1 ? '' : 's'}
              </span>
            )}
            {calendar.status === 'loading' && <span>· loading calendar…</span>}
          </span>
        </span>
        <Icon name={expandedOpen ? 'expand_less' : 'expand_more'} size={22} className="shrink-0 text-secondary" />
      </button>

      {expandedOpen && (
        <div className="border-t border-outline-variant px-md py-3.5">
          {calendar.status === 'loading' && (
            <p className="flex items-center gap-2 py-2 text-metadata text-secondary">
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
              Loading calendar…
            </p>
          )}
          {calendar.status === 'error' && (
            <p className="flex items-start gap-1.5 rounded-lg bg-error-container/70 px-3 py-2 text-metadata text-error">
              <Icon name="error" size={16} className="mt-0.5 shrink-0" />
              <span className="min-w-0 break-words">{calendar.message}</span>
            </p>
          )}

          {(groups.length > 0 || upcoming.length > 0) && (
            <ul className="flex flex-col gap-2">
              {groups.map((g) => (
                <MeetingGroupRow
                  key={g.key}
                  group={g}
                  onRemoveOne={(id) => onRemoveOne(id)}
                  onRemoveAll={() => onRemoveAll(g.occurrences.map((o) => o.id))}
                />
              ))}
              {upcoming.map((s) => (
                <ScheduleRow key={s.id} schedule={s} onCancel={() => onCancelSchedule(s.id)} />
              ))}
            </ul>
          )}

          {calendar.status === 'ready' && groups.length === 0 && upcoming.length === 0 && (
            <p className="py-3 text-center text-metadata text-secondary">
              No upcoming calendar meetings or schedules for this user.
            </p>
          )}

          {removedGroups.length > 0 && (
            <div className="mt-3">
              <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-outline">
                <Icon name="restore_from_trash" size={13} /> Removed
              </p>
              <ul className="flex flex-col gap-2">
                {removedGroups.map((g) => (
                  <RemovedGroupRow
                    key={`x-${g.key}`}
                    group={g}
                    onRestoreOne={(id) => onRestoreOne(id)}
                    onRestoreAll={() => onRestoreAll(g.occurrences.map((o) => o.id))}
                  />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </li>
  )
}
