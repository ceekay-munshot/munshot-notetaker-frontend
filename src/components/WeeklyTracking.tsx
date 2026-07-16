import { useEffect, useState } from 'react'
import { ApiError, fetchWeeklyTracking, type WeeklyTrackingPerson } from '../lib/api'
import { Icon } from './Icon'

// Admin-only: how each TRACKED person's week went — completed, newly opened,
// and carried-over-and-overdue — computed from the People Tracker's already
// reconciled structured items. Pure bucketing server-side (no AI call), so
// this loads instantly whenever the Weekly page is opened.

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; people: WeeklyTrackingPerson[] }

export function WeeklyTracking({ weekStartMs, weekEndMs }: { weekStartMs: number; weekEndMs: number }) {
  const [state, setState] = useState<State>({ status: 'loading' })

  useEffect(() => {
    let alive = true
    setState({ status: 'loading' })
    fetchWeeklyTracking({ weekStartMs, weekEndMs })
      .then((people) => {
        if (alive) setState({ status: 'ready', people })
      })
      .catch((err) => {
        if (!alive) return
        setState({
          status: 'error',
          message: err instanceof ApiError ? err.message : 'Could not load tracked people.',
        })
      })
    return () => {
      alive = false
    }
  }, [weekStartMs, weekEndMs])

  if (state.status === 'loading') {
    return (
      <section id="wk-tracking" className="mt-lg scroll-mt-20 border-t border-outline-variant pt-lg">
        <div className="grid place-items-center gap-2 rounded-xl border border-dashed border-outline-variant bg-surface-container-low py-lg text-center">
          <Icon name="groups" size={26} className="text-outline motion-safe:animate-pulse" />
          <p className="text-metadata text-secondary">Loading tracked people…</p>
        </div>
      </section>
    )
  }

  if (state.status === 'error') {
    return (
      <section id="wk-tracking" className="mt-lg scroll-mt-20 border-t border-outline-variant pt-lg">
        <div className="grid place-items-center gap-1 rounded-xl border border-dashed border-outline-variant bg-surface-container-low py-lg text-center">
          <Icon name="error" size={26} className="text-outline" />
          <p className="text-metadata text-secondary">{state.message}</p>
        </div>
      </section>
    )
  }

  if (state.people.length === 0) return null

  return (
    <section id="wk-tracking" className="mt-lg scroll-mt-20 border-t border-outline-variant pt-lg">
      <div className="mb-md">
        <h2 className="text-[22px] font-bold tracking-tight text-on-surface">Tracked People</h2>
        <p className="mt-0.5 text-metadata text-secondary">
          What each tracked person wrapped up this week, opened up, and is still carrying overdue.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-gutter lg:grid-cols-2">
        {state.people.map((p) => (
          <article key={p.slug} className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-md shadow-card">
            <h3 className="mb-3 text-[15px] font-semibold text-on-surface">{p.name}</h3>
            <div className="space-y-3">
              <TrackingColumn icon="check_circle" iconClass="text-success" title="Completed this week" items={p.completedThisWeek} />
              <TrackingColumn icon="radio_button_unchecked" iconClass="text-primary" title="Newly opened" items={p.openedThisWeek} />
              <TrackingColumn icon="warning" iconClass="text-error" title="Carried over & overdue" items={p.carriedOverdue} />
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

function TrackingColumn({ icon, iconClass, title, items }: { icon: string; iconClass: string; title: string; items: string[] }) {
  if (!items.length) return null
  return (
    <div>
      <p className="mb-1.5 flex items-center gap-1.5 text-label-caps uppercase tracking-wide text-on-surface-variant">
        <Icon name={icon} size={14} className={iconClass} /> {title}
      </p>
      <ul className="space-y-1">
        {items.map((it, i) => (
          <li key={i} className="text-[13px] leading-snug text-on-surface-variant">
            {it}
          </li>
        ))}
      </ul>
    </div>
  )
}
