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

/** Upcoming scheduled notetaker runs, with cancel. */
export function SchedulesCard() {
  const { schedules, deleteSchedule } = useAppData()
  const upcoming = useMemo(() => [...schedules].sort((a, b) => a.nextRun - b.nextRun), [schedules])

  return (
    <Card>
      <h3 className="mb-3 flex items-center gap-2 text-[17px] font-semibold text-on-surface">
        <Icon name="event" size={20} className="text-primary" /> Upcoming schedules
      </h3>
      {upcoming.length === 0 ? (
        <p className="py-4 text-center text-metadata text-secondary">No schedules yet. Schedule the notetaker above.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {upcoming.map((s) => (
            <ScheduleRow key={s.id} schedule={s} onCancel={() => deleteSchedule(s.id)} />
          ))}
        </ul>
      )}
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
function eventWhen(ev: CalendarEvent): string {
  const raw = ev.start || ev.start_time
  if (!raw) return ''
  const d = new Date(raw as string)
  return Number.isFinite(d.getTime())
    ? d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : String(raw)
}

/** Sync the calendar and list upcoming calendar meetings, each with a quick "send bot". */
export function CalendarCard() {
  const { calendarEvents, calendarLoading, syncCalendar, sendBot } = useAppData()
  const [msg, setMsg] = useState<string | null>(null)
  const [sendingId, setSendingId] = useState<string | null>(null)

  const withUrl = calendarEvents.filter((e) => eventUrl(e))

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-[17px] font-semibold text-on-surface">
          <Icon name="calendar_month" size={20} className="text-primary" /> Calendar
        </h3>
        <button
          type="button"
          disabled={calendarLoading}
          onClick={async () => {
            setMsg(null)
            try {
              await syncCalendar()
              setMsg('Calendar synced.')
            } catch {
              setMsg('Could not sync the calendar.')
            }
          }}
          className="press inline-flex items-center gap-1.5 rounded-lg border border-outline-variant px-2.5 py-1.5 text-metadata font-semibold text-primary hover:bg-surface-container-low disabled:opacity-50"
        >
          {calendarLoading ? (
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
          ) : (
            <Icon name="sync" size={16} />
          )}
          Sync calendar
        </button>
      </div>
      {withUrl.length === 0 ? (
        <p className="py-4 text-center text-metadata text-secondary">
          No upcoming meetings. Sync your calendar to pull them in.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {withUrl.slice(0, 6).map((ev, i) => {
            const id = eventUrl(ev) + i
            return (
              <li key={id} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-surface-container-low">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-metadata font-medium text-on-surface">{eventTitle(ev)}</p>
                  {eventWhen(ev) && <p className="text-[12px] text-secondary">{eventWhen(ev)}</p>}
                </div>
                <button
                  type="button"
                  disabled={sendingId === id}
                  onClick={async () => {
                    setSendingId(id)
                    setMsg(null)
                    try {
                      await sendBot(eventUrl(ev), 'join')
                      setMsg('Notetaker is joining.')
                    } catch {
                      setMsg('Could not send the notetaker.')
                    } finally {
                      setSendingId(null)
                    }
                  }}
                  className="press shrink-0 rounded-lg border border-outline-variant px-2.5 py-1.5 text-metadata font-medium text-primary hover:bg-surface disabled:opacity-50"
                >
                  Send bot
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {msg && <p className="mt-2 text-metadata text-secondary">{msg}</p>}
    </Card>
  )
}
