import { useEffect, useMemo, useState } from 'react'
import type { WeeklySchedule } from '../lib/types'
import { getWeeklySchedule, setWeeklySchedule } from '../lib/api'
import { Icon } from './Icon'

// Picks WHEN the weekly brief is mailed — day · time · timezone — in the user's own
// terms, then persists it (the cron endpoint enforces it). One global schedule (the
// shared edition), so it reads/writes the same value for everyone.

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const detectedZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** All IANA zones the runtime knows (falls back to a small curated set on old engines). */
function zoneList(): string[] {
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf
    if (typeof fn === 'function') return fn('timeZone')
  } catch {
    /* fall through */
  }
  return ['UTC', 'America/Los_Angeles', 'America/New_York', 'Europe/London', 'Europe/Berlin', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney']
}

/** "GMT+5:30" for a zone right now, for the option label (best-effort). */
function gmtLabel(tz: string): string {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date())
    return p.find((x) => x.type === 'timeZoneName')?.value ?? ''
  } catch {
    return ''
  }
}

/** "9:00 AM" from 24h parts. */
function prettyTime(hour: number, minute: number): string {
  const h12 = ((hour + 11) % 12) + 1
  return `${h12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`
}

const DEFAULT_DRAFT = (): WeeklySchedule => ({ dayOfWeek: 1, hour: 9, minute: 0, timezone: detectedZone() })
const same = (a: WeeklySchedule, b: WeeklySchedule) => a.dayOfWeek === b.dayOfWeek && a.hour === b.hour && a.minute === b.minute && a.timezone === b.timezone

export function WeeklyScheduleEditor() {
  const [saved, setSaved] = useState<WeeklySchedule | null>(null) // last persisted value
  const [draft, setDraft] = useState<WeeklySchedule>(DEFAULT_DRAFT)
  const [state, setState] = useState<'loading' | 'idle' | 'saving' | 'done' | 'error'>('loading')
  const [msg, setMsg] = useState('')

  useEffect(() => {
    let alive = true
    getWeeklySchedule().then((s) => {
      if (!alive) return
      const next = s ?? DEFAULT_DRAFT()
      setSaved(next)
      setDraft(next)
      setState('idle')
    })
    return () => {
      alive = false
    }
  }, [])

  // Reset the "Saved ✓" flash back to idle after it breathes.
  useEffect(() => {
    if (state !== 'done') return
    const t = setTimeout(() => setState('idle'), 1800)
    return () => clearTimeout(t)
  }, [state])

  const zones = useMemo(() => {
    const list = zoneList()
    const withSelf = list.includes(draft.timezone) ? list : [draft.timezone, ...list]
    return withSelf.map((tz) => ({ tz, label: `${tz.replace(/_/g, ' ')}${gmtLabel(tz) ? ` (${gmtLabel(tz)})` : ''}` }))
    // Recompute only if the (rare) custom zone changes — offsets are "now"-stable enough for a label.
  }, [draft.timezone])

  const dirty = !saved || !same(draft, saved)
  const set = (patch: Partial<WeeklySchedule>) => {
    setDraft((d) => ({ ...d, ...patch }))
    if (state === 'done' || state === 'error') setState('idle')
  }

  const save = async () => {
    if (!dirty || state === 'saving') return
    setState('saving')
    setMsg('')
    const res = await setWeeklySchedule(draft)
    if (res.ok && res.schedule) {
      setSaved(res.schedule)
      setDraft(res.schedule)
      setState('done')
    } else {
      setMsg(res.message || "Couldn't save")
      setState('error')
    }
  }

  const field = 'rounded-lg border border-outline-variant bg-surface px-2.5 py-2 text-[13px] text-on-surface outline-none transition-colors focus:border-primary'

  return (
    <div className="mt-3 border-t border-outline-variant pt-3">
      <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-secondary">
        <Icon name="schedule" size={13} className="text-primary" /> When it sends
      </p>

      <div className="flex gap-2">
        <select
          aria-label="Day of week"
          value={draft.dayOfWeek}
          onChange={(e) => set({ dayOfWeek: Number(e.target.value) })}
          disabled={state === 'loading'}
          className={`${field} flex-1`}
        >
          {DAYS.map((d, i) => (
            <option key={i} value={i}>
              {d}
            </option>
          ))}
        </select>
        <input
          aria-label="Time of day"
          type="time"
          value={`${String(draft.hour).padStart(2, '0')}:${String(draft.minute).padStart(2, '0')}`}
          onChange={(e) => {
            const [h, m] = e.target.value.split(':').map(Number)
            if (Number.isFinite(h) && Number.isFinite(m)) set({ hour: h, minute: m })
          }}
          disabled={state === 'loading'}
          className={`${field} w-[108px]`}
        />
      </div>

      <select
        aria-label="Timezone"
        value={draft.timezone}
        onChange={(e) => set({ timezone: e.target.value })}
        disabled={state === 'loading'}
        className={`${field} mt-2 w-full`}
      >
        {zones.map(({ tz, label }) => (
          <option key={tz} value={tz}>
            {label}
          </option>
        ))}
      </select>

      <p className="mt-2.5 text-[12px] leading-snug text-on-surface-variant">
        Sends every <span className="font-semibold text-on-surface">{DAYS[draft.dayOfWeek]}</span> at{' '}
        <span className="font-semibold text-on-surface">{prettyTime(draft.hour, draft.minute)}</span>
        <span className="text-secondary"> · {draft.timezone.replace(/_/g, ' ')}</span>
      </p>

      <button
        onClick={save}
        disabled={state === 'loading' || state === 'saving' || (!dirty && state !== 'error')}
        className={`press mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-lg px-md py-2 text-[13px] font-semibold disabled:cursor-default ${
          state === 'done' ? 'bg-success-container text-on-success-container' : 'bg-primary text-on-primary hover:bg-primary-container disabled:opacity-45'
        }`}
      >
        {state === 'saving' ? (
          <>
            <Icon name="progress_activity" size={15} className="animate-spin" /> Saving…
          </>
        ) : state === 'done' ? (
          <span key="done" className="node-pop inline-flex items-center gap-1.5">
            <Icon name="check_circle" size={15} fill /> Saved
          </span>
        ) : dirty ? (
          'Save schedule'
        ) : (
          'Saved'
        )}
      </button>
      {state === 'error' && (
        <p className="mt-1.5 flex items-start gap-1 text-[11.5px] text-error" role="alert">
          <Icon name="error" size={13} className="mt-px shrink-0" />
          <span>{msg}</span>
        </p>
      )}
      <p className="mt-2 text-[11px] leading-snug text-secondary">Applies to everyone subscribed. Goes out within ~30 min of the chosen time.</p>
    </div>
  )
}
