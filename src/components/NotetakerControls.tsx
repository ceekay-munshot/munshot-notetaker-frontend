import { useMemo, useState } from 'react'
import { useAppData } from '../store/AppData'
import type { CalendarEvent, NewSchedule, Schedule } from '../lib/api'
import { ApiError } from '../lib/api'
import { Icon } from '../components/Icon'

// The notetaker action surface for the Home page: send the bot to a meeting now
// or on a schedule, see upcoming schedules, and sync the calendar. All wired to
// the Worker's /api routes via the AppData store.

type Recurrence = NewSchedule['recurrence']
const RECURRENCES: { value: Recurrence; label: string }[] = [
  { value: 'once', label: 'Once' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekly', label: 'Weekly' },
]

const BROWSER_TZ = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
})()

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-outline-variant bg-surface-container-lowest p-md shadow-card ${className}`}>
      {children}
    </div>
  )
}

const inputCls =
  'w-full rounded-lg border border-outline-variant bg-surface px-3 py-2.5 text-body-md text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/20'

function Note({ kind, children }: { kind: 'ok' | 'err'; children: React.ReactNode }) {
  const cls =
    kind === 'ok'
      ? 'bg-success-container/70 text-on-success-container'
      : 'bg-error-container/70 text-error'
  return (
    <p className={`mt-2 flex items-start gap-1.5 rounded-lg px-3 py-2 text-metadata ${cls}`}>
      <Icon name={kind === 'ok' ? 'check_circle' : 'error'} size={16} className="mt-0.5 shrink-0" />
      <span className="min-w-0 break-words">{children}</span>
    </p>
  )
}

/** Send the notetaker to a meeting now, or schedule it for later. */
export function SendBotCard() {
  const { sendBot, createSchedule } = useAppData()
  const [url, setUrl] = useState('')
  const [scheduleOn, setScheduleOn] = useState(false)
  const [when, setWhen] = useState('')
  const [recurrence, setRecurrence] = useState<Recurrence>('once')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setMsg(null)
    setBusy(true)
    try {
      if (scheduleOn) {
        if (!when) throw new ApiError('Pick a date and time', 400)
        await createSchedule({ meeting_url: url.trim(), local_datetime: when, recurrence, time_zone: BROWSER_TZ })
        setMsg({ kind: 'ok', text: 'Scheduled. The notetaker will join on time.' })
        setUrl('')
        setWhen('')
      } else {
        await sendBot(url.trim(), 'join')
        setMsg({ kind: 'ok', text: 'Notetaker is joining the meeting.' })
        setUrl('')
      }
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof ApiError ? err.message : 'Could not reach the notetaker.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <h3 className="mb-3 flex items-center gap-2 text-[17px] font-semibold text-on-surface">
        <Icon name="smart_toy" size={20} className="text-primary" /> Send the notetaker
      </h3>
      <form onSubmit={submit} className="flex flex-col gap-2.5">
        <input
          type="url"
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste a meeting link (Meet, Zoom, Teams…)"
          className={inputCls}
        />
        <label className="flex items-center gap-2 text-metadata text-on-surface-variant">
          <input
            type="checkbox"
            checked={scheduleOn}
            onChange={(e) => setScheduleOn(e.target.checked)}
            className="h-4 w-4 rounded border-outline-variant text-primary focus:ring-primary/30"
          />
          Schedule for later
        </label>
        {scheduleOn && (
          <div className="flex flex-col gap-2.5 rounded-lg border border-outline-variant bg-surface-container-low p-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className={inputCls} />
              <select value={recurrence} onChange={(e) => setRecurrence(e.target.value as Recurrence)} className={inputCls}>
                {RECURRENCES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            <p className="text-[12px] text-outline">
              <Icon name="schedule" size={13} className="mr-1 align-text-bottom" />
              Times are in your timezone ({BROWSER_TZ}).
            </p>
          </div>
        )}
        <button
          type="submit"
          disabled={busy || !url.trim()}
          className="press mt-1 inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-metadata font-semibold text-on-primary hover:bg-primary-container disabled:opacity-50"
        >
          {busy ? (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-on-primary/40 border-t-on-primary" />
          ) : (
            <Icon name={scheduleOn ? 'event_upcoming' : 'send' } size={18} />
          )}
          {scheduleOn ? 'Schedule notetaker' : 'Send notetaker now'}
        </button>
        {msg && <Note kind={msg.kind}>{msg.text}</Note>}
      </form>
    </Card>
  )
}

function fmtNextRun(ms: number, tz: string): string {
  try {
    return new Date(ms).toLocaleString('en-US', {
      timeZone: tz,
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return new Date(ms).toLocaleString()
  }
}

const RECUR_LABEL: Record<string, string> = {
  once: 'One-time',
  daily: 'Daily',
  weekdays: 'Weekdays',
  weekly: 'Weekly',
}

/** Upcoming: calendar meetings + scheduled notetaker runs together. Send the bot,
 *  remove a calendar meeting, cancel a schedule, and sync the calendar — all here. */
export function SchedulesCard() {
  const {
    schedules,
    deleteSchedule,
    calendarEvents,
    calendarLoading,
    syncCalendar,
    sendBot,
    removeCalendarEvent,
    removeCalendarEvents,
    cancelledEvents,
    restoreCalendarEvent,
    restoreCalendarEvents,
  } = useAppData()
  const upcoming = useMemo(() => [...schedules].sort((a, b) => a.nextRun - b.nextRun), [schedules])
  const groups = useMemo(() => groupEvents(calendarEvents), [calendarEvents])
  const removedGroups = useMemo(() => groupEvents(cancelledEvents), [cancelledEvents])
  const [msg, setMsg] = useState<
    { kind: 'ok' | 'err'; text: string; undo?: () => Promise<void>; connectUrl?: string } | null
  >(null)
  const empty = upcoming.length === 0 && groups.length === 0

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-[17px] font-semibold text-on-surface">
          <Icon name="event" size={20} className="text-primary" /> Upcoming schedules
        </h3>
        <button
          type="button"
          disabled={calendarLoading}
          onClick={async () => {
            setMsg(null)
            try {
              const { count, note, connectUrl } = await syncCalendar()
              if (count > 0) {
                setMsg({ kind: 'ok', text: `Calendar synced — ${count} upcoming meeting${count === 1 ? '' : 's'}.` })
              } else if (connectUrl) {
                // Not connected yet: the upstream handed back an authorization
                // link. Show a real button so the user can grant access.
                setMsg({
                  kind: 'err',
                  text: 'Your calendar isn’t connected yet. Authorize access to import your meetings.',
                  connectUrl,
                })
              } else {
                // The request succeeded but nothing came back. Say so honestly
                // (and pass along any note the server sent) instead of a
                // misleading "synced" with an empty list.
                setMsg({
                  kind: 'err',
                  text: note
                    ? `Synced, but no upcoming meetings found: ${note}`
                    : 'Synced, but no upcoming meetings were found. Make sure your calendar is connected.',
                })
              }
            } catch {
              setMsg({ kind: 'err', text: 'Could not sync the calendar.' })
            }
          }}
          className="press inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-outline-variant px-2.5 py-1.5 text-metadata font-semibold text-primary hover:bg-surface-container-low disabled:opacity-50"
        >
          {calendarLoading ? (
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
          ) : (
            <Icon name="sync" size={16} />
          )}
          Sync calendar
        </button>
      </div>
      {empty ? (
        <p className="py-4 text-center text-metadata text-secondary">
          No upcoming meetings or schedules. Schedule the notetaker above, or sync your calendar.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {groups.map((g) => (
            <MeetingGroupRow
              key={g.key}
              group={g}
              onSend={async () => {
                setMsg(null)
                try {
                  await sendBot(g.url, 'join')
                  setMsg({ kind: 'ok', text: 'Notetaker is joining.' })
                } catch {
                  setMsg({ kind: 'err', text: 'Could not send the notetaker.' })
                }
              }}
              onRemoveOne={async (id) => {
                setMsg(null)
                try {
                  await removeCalendarEvent(id)
                  setMsg({
                    kind: 'ok',
                    text: "Removed — the bot won't join that one.",
                    undo: async () => {
                      try {
                        await restoreCalendarEvent(id)
                        setMsg({ kind: 'ok', text: 'Restored.' })
                      } catch {
                        setMsg({ kind: 'err', text: 'Could not restore.' })
                      }
                    },
                  })
                } catch {
                  setMsg({ kind: 'err', text: 'Could not remove the meeting.' })
                }
              }}
              onRemoveAll={async () => {
                const ids = g.occurrences.map((o) => o.id)
                setMsg(null)
                try {
                  await removeCalendarEvents(ids)
                  setMsg({
                    kind: 'ok',
                    text: 'Recurring meeting removed.',
                    undo: async () => {
                      try {
                        await restoreCalendarEvents(ids)
                        setMsg({ kind: 'ok', text: 'Restored.' })
                      } catch {
                        setMsg({ kind: 'err', text: 'Could not restore.' })
                      }
                    },
                  })
                } catch {
                  setMsg({ kind: 'err', text: 'Could not remove the meeting.' })
                }
              }}
            />
          ))}
          {upcoming.map((s) => (
            <ScheduleRow key={s.id} schedule={s} onCancel={() => deleteSchedule(s.id)} />
          ))}
        </ul>
      )}
      {removedGroups.length > 0 ? (
        <div className="mt-3">
          <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-outline">
            <Icon name="restore_from_trash" size={13} /> Removed
          </p>
          <ul className="flex flex-col gap-2">
            {removedGroups.map((g) => (
              <RemovedGroupRow
                key={`x-${g.key}`}
                group={g}
                onRestoreOne={async (id) => {
                  setMsg(null)
                  try {
                    await restoreCalendarEvent(id)
                    setMsg({ kind: 'ok', text: 'Restored — the bot will join it again.' })
                  } catch {
                    setMsg({ kind: 'err', text: 'Could not restore the meeting.' })
                  }
                }}
                onRestoreAll={async () => {
                  setMsg(null)
                  try {
                    await restoreCalendarEvents(g.occurrences.map((o) => o.id))
                    setMsg({ kind: 'ok', text: 'Recurring meeting restored.' })
                  } catch {
                    setMsg({ kind: 'err', text: 'Could not restore the meeting.' })
                  }
                }}
              />
            ))}
          </ul>
        </div>
      ) : null}
      {msg ? (
        <p
          className={`mt-2 flex items-center gap-2 rounded-lg px-3 py-2 text-metadata ${
            msg.kind === 'ok' ? 'bg-success-container/70 text-on-success-container' : 'bg-error-container/70 text-error'
          }`}
        >
          <Icon name={msg.kind === 'ok' ? 'check_circle' : 'error'} size={16} className="shrink-0" />
          <span className="min-w-0 flex-1 break-words">{msg.text}</span>
          {msg.connectUrl ? (
            <a
              href={msg.connectUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="press inline-flex shrink-0 items-center gap-1 rounded-md border border-current px-2 py-0.5 text-[12px] font-semibold"
            >
              <Icon name="link" size={14} />
              Connect calendar
            </a>
          ) : null}
          {msg.undo ? (
            <button
              type="button"
              onClick={() => {
                void msg?.undo?.()
              }}
              className="press shrink-0 rounded-md border border-current px-2 py-0.5 text-[12px] font-semibold"
            >
              Undo
            </button>
          ) : null}
        </p>
      ) : null}
    </Card>
  )
}

function ScheduleRow({ schedule, onCancel }: { schedule: Schedule; onCancel: () => Promise<void> | void }) {
  const [busy, setBusy] = useState(false)
  return (
    <li className="flex items-center gap-3 rounded-lg border border-outline-variant bg-surface px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-metadata font-semibold text-on-surface">
          {fmtNextRun(schedule.nextRun, schedule.timeZone)}
          <span className="rounded-full bg-primary-fixed px-2 py-0.5 text-[11px] font-semibold text-on-primary-container">
            {RECUR_LABEL[schedule.recurrence] || schedule.recurrence}
          </span>
        </p>
        <p className="truncate text-[12px] text-secondary">{schedule.meetingUrl}</p>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          try {
            await onCancel()
          } finally {
            setBusy(false)
          }
        }}
        className="press shrink-0 rounded-lg border border-outline-variant px-2.5 py-1.5 text-metadata font-medium text-secondary hover:bg-surface-container-low hover:text-error disabled:opacity-50"
      >
        Cancel
      </button>
    </li>
  )
}

function eventUrl(ev: CalendarEvent): string {
  return String(ev.meeting_url || ev.url || '')
}
function eventTitle(ev: CalendarEvent): string {
  return String(ev.title || ev.summary || 'Meeting')
}
function platformLabel(p: unknown): string {
  const s = String(p || '')
  if (s === 'google_meet') return 'Google Meet'
  if (s === 'browser_session') return 'Browser'
  return s.replace(/_/g, ' ')
}
function startMs(s?: string): number {
  if (!s) return Number.POSITIVE_INFINITY
  const t = new Date(s).getTime()
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY
}
function occLabel(start?: string): string {
  if (!start) return '—'
  const d = new Date(start)
  return Number.isFinite(d.getTime())
    ? d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : start
}

interface Occurrence {
  id: number | string
  start?: string
  status?: string
}
interface MeetingGroup {
  key: string
  title: string
  url: string
  platform?: string
  occurrences: Occurrence[]
  next?: Occurrence
}

// Collapse repeated calendar instances (same meeting link = one recurring series)
// into a single group each, ordered by their next occurrence.
function groupEvents(events: CalendarEvent[]): MeetingGroup[] {
  const map = new Map<string, MeetingGroup>()
  for (const ev of events) {
    const url = eventUrl(ev)
    const key = url || eventTitle(ev)
    let g = map.get(key)
    if (!g) {
      g = { key, title: eventTitle(ev), url, platform: ev.platform, occurrences: [] }
      map.set(key, g)
    }
    if (ev.id != null) {
      g.occurrences.push({ id: ev.id, start: ev.start_time || ev.start, status: ev.status })
    }
  }
  const now = Date.now()
  const groups = [...map.values()]
  for (const g of groups) {
    g.occurrences.sort((a, b) => startMs(a.start) - startMs(b.start))
    g.next = g.occurrences.find((o) => startMs(o.start) >= now) || g.occurrences[0]
  }
  groups.sort((a, b) => startMs(a.next?.start) - startMs(b.next?.start))
  return groups
}

/** One meeting series: name + next date + recurrence count, with send-bot and a
 *  remove menu that drops either one occurrence or the whole recurrence. */
function MeetingGroupRow({
  group,
  onSend,
  onRemoveOne,
  onRemoveAll,
}: {
  group: MeetingGroup
  onSend: () => Promise<void>
  onRemoveOne: (id: number | string) => Promise<void>
  onRemoveAll: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const recurring = group.occurrences.length > 1
  const next = group.next

  async function run(fn: () => Promise<void>, close = false) {
    setBusy(true)
    try {
      await fn()
      if (close) setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="rounded-lg border border-outline-variant bg-surface">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-metadata font-semibold text-on-surface">{group.title}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-secondary">
            {next?.start ? <span>{occLabel(next.start)}</span> : null}
            {group.platform ? <span>· {platformLabel(group.platform)}</span> : null}
            {recurring ? (
              <span className="rounded-full bg-primary-fixed px-2 py-0.5 text-[11px] font-semibold text-on-primary-container">
                Recurring · {group.occurrences.length}×
              </span>
            ) : next?.status ? (
              <span className="rounded-full bg-surface-container-high px-1.5 py-0.5 text-[11px] font-medium capitalize text-on-surface-variant">
                {String(next.status)}
              </span>
            ) : null}
          </p>
        </div>
        {group.url ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => run(onSend)}
            className="press shrink-0 rounded-lg border border-outline-variant px-2.5 py-1.5 text-metadata font-medium text-primary hover:bg-surface-container-low disabled:opacity-50"
          >
            Send bot
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => setOpen((v) => !v)}
          className="press shrink-0 rounded-lg border border-outline-variant px-2.5 py-1.5 text-metadata font-medium text-secondary hover:bg-surface-container-low hover:text-error disabled:opacity-50"
        >
          Remove
        </button>
      </div>
      {open ? (
        <div className="border-t border-outline-variant px-3 py-2.5">
          {recurring ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => run(onRemoveAll, true)}
                className="press w-full rounded-lg bg-error-container/70 px-3 py-2 text-metadata font-semibold text-error hover:bg-error-container disabled:opacity-50"
              >
                Remove whole recurring meeting ({group.occurrences.length})
              </button>
              <p className="mb-1 mt-2.5 text-[11px] font-medium uppercase tracking-wide text-outline">Or remove one date</p>
              <ul className="flex flex-col gap-1">
                {group.occurrences.map((o) => (
                  <li
                    key={String(o.id)}
                    className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-surface-container-low"
                  >
                    <span className="text-[12px] text-secondary">
                      {occLabel(o.start)}
                      {o.status ? <span className="ml-1.5 capitalize text-outline">· {String(o.status)}</span> : null}
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => run(() => onRemoveOne(o.id))}
                      className="press shrink-0 rounded-md border border-outline-variant px-2 py-1 text-[12px] font-medium text-secondary hover:text-error disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => run(() => onRemoveOne(group.occurrences[0]?.id ?? ''), true)}
              className="press w-full rounded-lg bg-error-container/70 px-3 py-2 text-metadata font-semibold text-error hover:bg-error-container disabled:opacity-50"
            >
              Remove this meeting
            </button>
          )}
        </div>
      ) : null}
    </li>
  )
}

/** A removed (cancelled) meeting series, with restore for one date or the whole series. */
function RemovedGroupRow({
  group,
  onRestoreOne,
  onRestoreAll,
}: {
  group: MeetingGroup
  onRestoreOne: (id: number | string) => Promise<void>
  onRestoreAll: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const recurring = group.occurrences.length > 1

  async function run(fn: () => Promise<void>, close = false) {
    setBusy(true)
    try {
      await fn()
      if (close) setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="rounded-lg border border-outline-variant bg-surface-container-low">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-metadata font-medium text-secondary">{group.title}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-outline">
            {group.next?.start ? <span>{occLabel(group.next.start)}</span> : null}
            <span>· {recurring ? `${group.occurrences.length}× cancelled` : 'cancelled'}</span>
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => (recurring ? setOpen((v) => !v) : run(() => onRestoreOne(group.occurrences[0]?.id ?? '')))}
          className="press shrink-0 rounded-lg border border-outline-variant px-2.5 py-1.5 text-metadata font-medium text-primary hover:bg-surface disabled:opacity-50"
        >
          Restore
        </button>
      </div>
      {open && recurring ? (
        <div className="border-t border-outline-variant px-3 py-2.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => run(onRestoreAll, true)}
            className="press w-full rounded-lg bg-primary px-3 py-2 text-metadata font-semibold text-on-primary hover:bg-primary-container disabled:opacity-50"
          >
            Restore whole recurring meeting ({group.occurrences.length})
          </button>
          <p className="mb-1 mt-2.5 text-[11px] font-medium uppercase tracking-wide text-outline">Or restore one date</p>
          <ul className="flex flex-col gap-1">
            {group.occurrences.map((o) => (
              <li
                key={String(o.id)}
                className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-surface"
              >
                <span className="text-[12px] text-secondary">{occLabel(o.start)}</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run(() => onRestoreOne(o.id))}
                  className="press shrink-0 rounded-md border border-outline-variant px-2 py-1 text-[12px] font-medium text-primary disabled:opacity-50"
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </li>
  )
}
