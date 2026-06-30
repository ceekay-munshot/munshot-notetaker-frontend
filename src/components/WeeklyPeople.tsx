import { useEffect, useState } from 'react'
import { ApiError, fetchWeeklyPeople, type PersonRollup } from '../lib/api'
import { Icon } from './Icon'

// Per-person rollup across the week's meetings: each participant's overall view,
// what they've accomplished, and their current to-dos. Generated server-side
// (OpenAI over the user's transcripts) and fetched on demand.

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string; needsKey: boolean }
  | { status: 'ready'; people: PersonRollup[] }

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const chars = parts.length >= 2 ? parts[0][0] + parts[1][0] : name.slice(0, 2)
  return chars.toUpperCase()
}

export function WeeklyPeople() {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let alive = true
    setState({ status: 'loading' })
    fetchWeeklyPeople()
      .then((people) => {
        if (alive) setState({ status: 'ready', people })
      })
      .catch((err) => {
        if (!alive) return
        const needsKey = err instanceof ApiError && err.status === 503
        setState({
          status: 'error',
          needsKey,
          message: err instanceof ApiError ? err.message : 'Could not build the per-person summary.',
        })
      })
    return () => {
      alive = false
    }
  }, [reloadKey])

  return (
    <section id="wk-people" className="mt-lg scroll-mt-20 border-t border-outline-variant pt-lg">
      <div className="mb-md flex items-center justify-between">
        <div>
          <h2 className="text-[22px] font-bold tracking-tight text-on-surface">Per-Person Summary</h2>
          <p className="mt-0.5 text-metadata text-secondary">What each person is working on, what they've done, and what's next.</p>
        </div>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          disabled={state.status === 'loading'}
          className="press inline-flex items-center gap-1.5 rounded-lg border border-outline-variant bg-surface px-3 py-2 text-metadata font-semibold text-on-surface hover:bg-surface-container-low disabled:opacity-50"
        >
          <Icon name="refresh" size={16} className={state.status === 'loading' ? 'motion-safe:animate-spin' : ''} />
          <span className="hidden sm:inline">Regenerate</span>
        </button>
      </div>

      {state.status === 'loading' && (
        <div className="grid place-items-center gap-2 rounded-xl border border-dashed border-outline-variant bg-surface-container-low py-xl text-center">
          <Icon name="groups" size={30} className="text-outline motion-safe:animate-pulse" />
          <p className="text-metadata text-secondary">Reading the meetings and building each person's rollup…</p>
        </div>
      )}

      {state.status === 'error' && (
        <div className="grid place-items-center gap-1 rounded-xl border border-dashed border-outline-variant bg-surface-container-low py-lg text-center">
          <Icon name={state.needsKey ? 'key_off' : 'error'} size={26} className="text-outline" />
          <p className="text-metadata text-secondary">{state.message}</p>
        </div>
      )}

      {state.status === 'ready' && state.people.length === 0 && (
        <div className="grid place-items-center gap-1 rounded-xl border border-dashed border-outline-variant bg-surface-container-low py-lg text-center">
          <Icon name="groups" size={26} className="text-outline" />
          <p className="text-metadata text-secondary">No per-person updates found in your meetings yet.</p>
        </div>
      )}

      {state.status === 'ready' && state.people.length > 0 && (
        <div className="grid grid-cols-1 gap-gutter lg:grid-cols-2">
          {state.people.map((p) => (
            <PersonCard key={p.name} person={p} />
          ))}
        </div>
      )}
    </section>
  )
}

function PersonCard({ person }: { person: PersonRollup }) {
  return (
    <article className="flex flex-col rounded-2xl border border-outline-variant bg-surface-container-lowest p-md shadow-card">
      <header className="mb-3 flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary-fixed/70 text-[13px] font-bold text-primary">
          {initials(person.name)}
        </span>
        <h3 className="text-[17px] font-semibold text-on-surface">{person.name}</h3>
      </header>

      {person.overall && (
        <p className="mb-3 text-body-md leading-relaxed text-on-surface-variant">{person.overall}</p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Column
          icon="check_circle"
          iconClass="text-success"
          title="Accomplished"
          items={person.accomplished}
          empty="Nothing logged yet."
          marker="bg-success"
        />
        <Column
          icon="radio_button_unchecked"
          iconClass="text-primary"
          title="To do"
          items={person.todo}
          empty="No open tasks."
          marker="bg-primary"
        />
      </div>
    </article>
  )
}

function Column({
  icon,
  iconClass,
  title,
  items,
  empty,
  marker,
}: {
  icon: string
  iconClass: string
  title: string
  items: string[]
  empty: string
  marker: string
}) {
  return (
    <div className="rounded-xl border border-outline-variant bg-surface-container-low p-3">
      <p className="mb-2 flex items-center gap-1.5 text-label-caps uppercase tracking-wide text-on-surface-variant">
        <Icon name={icon} size={15} className={iconClass} /> {title}
      </p>
      {items.length === 0 ? (
        <p className="text-[13px] text-outline">{empty}</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((it, i) => (
            <li key={i} className="flex gap-2 text-[13.5px] leading-snug text-on-surface-variant">
              <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${marker}`} />
              <span>{it}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
