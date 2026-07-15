import { useState } from 'react'
import type { CalendarEvent, Schedule } from '../lib/api'

// Presentational rows shared between the per-user "Upcoming schedules" card
// (NotetakerControls.tsx) and the admin "Scheduled Meetings" cross-user view.
// No data-fetching or context here — callers own the data and the mutations.

export function fmtNextRun(ms: number, tz: string): string {
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

export const RECUR_LABEL: Record<string, string> = {
  once: 'One-time',
  daily: 'Daily',
  weekdays: 'Weekdays',
  weekly: 'Weekly',
}

export function ScheduleRow({ schedule, onCancel }: { schedule: Schedule; onCancel: () => Promise<void> | void }) {
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
export interface MeetingGroup {
  key: string
  title: string
  url: string
  platform?: string
  occurrences: Occurrence[]
  next?: Occurrence
}

// Collapse repeated calendar instances (same meeting link = one recurring series)
// into a single group each, ordered by their next occurrence.
export function groupEvents(events: CalendarEvent[]): MeetingGroup[] {
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
export function MeetingGroupRow({
  group,
  onSend,
  onRemoveOne,
  onRemoveAll,
}: {
  group: MeetingGroup
  onSend?: () => Promise<void>
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
        {group.url && onSend ? (
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
export function RemovedGroupRow({
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
