import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { NOW } from '../lib/format'

// Global date-range filter shared by the top-bar pill, the Episodes list, and
// the Home dashboard. A preset is a rolling window of `days` ending today (NOW).

export interface DatePreset {
  id: string
  /** Menu label, e.g. "Last 7 days". */
  label: string
  /** Title for the Home stats card, e.g. "This Week". */
  stat: string
  /** Window length in days (inclusive). null = all time. */
  days: number | null
}

export const PRESETS: DatePreset[] = [
  { id: 'today', label: 'Today', stat: 'Today', days: 1 },
  { id: 'week', label: 'Last 7 days', stat: 'This Week', days: 7 },
  { id: 'month', label: 'Last 30 days', stat: 'This Month', days: 30 },
  { id: 'quarter', label: 'Last 90 days', stat: 'Last 90 Days', days: 90 },
  { id: 'all', label: 'All time', stat: 'All Time', days: null },
]

const DAY = 86_400_000

function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

interface DateRangeValue {
  preset: DatePreset
  presets: DatePreset[]
  setPreset: (id: string) => void
  /** Human range, e.g. "May 30 – Jun 5, 2026" or "All time". */
  rangeLabel: string
  /** True if an ISO date falls inside the active window. */
  inRange: (iso: string) => boolean
}

const Ctx = createContext<DateRangeValue | null>(null)

export function DateRangeProvider({ children }: { children: ReactNode }) {
  // Default to "All time" so freshly pulled feed episodes always show, whatever
  // their publish dates — the user can narrow from the top-bar pill.
  const [presetId, setPresetId] = useState('all')
  // Fall back to "All time" (the documented default) for an unknown id, not a
  // 7-day window that would silently hide most episodes.
  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[PRESETS.length - 1]

  const setPreset = useCallback((id: string) => setPresetId(id), [])

  const inRange = useCallback(
    (iso: string) => {
      if (preset.days === null) return true
      const ageDays = Math.floor((startOfDay(NOW) - startOfDay(+new Date(iso))) / DAY)
      return ageDays >= 0 && ageDays < preset.days
    },
    [preset],
  )

  const rangeLabel = useMemo(() => {
    if (preset.days === null) return 'All time'
    const end = new Date(NOW)
    const start = new Date(startOfDay(NOW) - (preset.days - 1) * DAY)
    const short = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    const full = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    return preset.days === 1 ? full(end) : `${short(start)} – ${full(end)}`
  }, [preset])

  const value = useMemo<DateRangeValue>(
    () => ({ preset, presets: PRESETS, setPreset, rangeLabel, inRange }),
    [preset, setPreset, rangeLabel, inRange],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useDateRange(): DateRangeValue {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useDateRange must be used within <DateRangeProvider>')
  return ctx
}
