import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useAppData } from '../store/AppData'
import { listEditions } from '../lib/weeklyEditions'
import { Icon } from '../components/Icon'

// The complete history of weekly editions — a timeline of every analysed week,
// newest first. Each card is a rich preview (range, episode + idea counts, the
// shows, and a concrete headline) that opens the full edition at /weekly?week=…
// Everything here is deterministic, so the list is instant (no AI/network).
export default function WeeklyArchive() {
  const { episodes, podcastById, loading } = useAppData()
  const editions = useMemo(() => listEditions(episodes, podcastById), [episodes, podcastById])

  return (
    <div className="animate-fade-up">
      <div className="mb-lg flex flex-wrap items-start justify-between gap-md">
        <div>
          <p className="text-metadata font-semibold uppercase tracking-wide text-primary">Weekly Summary</p>
          <h1 className="mt-1 text-display-lg tracking-tight text-on-surface">Past Editions</h1>
          <p className="mt-1 text-body-md text-secondary">
            {editions.length
              ? `${editions.length} edition${editions.length === 1 ? '' : 's'} · every analysed week, newest first`
              : 'Your weekly editions will appear here'}
          </p>
        </div>
        <Link
          to="/weekly"
          className="press inline-flex items-center gap-2 rounded-lg bg-primary px-md py-2.5 text-metadata font-semibold text-on-primary hover:bg-primary-container"
        >
          <Icon name="bar_chart" size={18} /> Current edition
        </Link>
      </div>

      {loading && !editions.length ? (
        <LoadingState />
      ) : !editions.length ? (
        <EmptyState />
      ) : (
        <ol className="relative ml-2 border-l border-outline-variant">
          {editions.map((e, i) => (
            <li key={e.weekKey} className="relative mb-4 pl-6">
              <span
                className={`absolute -left-[7px] top-5 h-3 w-3 rounded-full border-2 ${
                  i === 0 ? 'border-primary bg-primary' : 'border-outline bg-surface'
                }`}
              />
              <Link
                to={`/weekly?week=${e.weekKey}`}
                className="group block rounded-2xl border border-outline-variant bg-surface-container-lowest p-md shadow-card transition hover:border-primary/40 hover:shadow-card-hover"
              >
                <div className="flex items-start justify-between gap-md">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-[18px] font-bold tracking-tight text-on-surface">{e.rangeLabel}</h2>
                      {i === 0 && (
                        <span className="rounded-full bg-primary-fixed/70 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary">
                          Latest
                        </span>
                      )}
                    </div>
                    <p className="mt-1 line-clamp-2 text-body-md text-on-surface-variant">{e.headline}</p>
                  </div>
                  <Icon
                    name="arrow_forward"
                    size={20}
                    className="mt-1 shrink-0 text-secondary transition group-hover:translate-x-0.5 group-hover:text-primary"
                  />
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-metadata">
                  <Stat icon="play_circle" label={`${e.episodeCount} episode${e.episodeCount === 1 ? '' : 's'}`} />
                  {e.ideaCount > 0 && <Stat icon="trending_up" label={`${e.ideaCount} idea${e.ideaCount === 1 ? '' : 's'} pitched`} />}
                  <span className="flex flex-wrap gap-1.5">
                    {e.shows.slice(0, 4).map((s) => (
                      <span key={s} className="rounded-full border border-outline-variant bg-surface px-2.5 py-1 text-[12px] text-on-surface-variant">
                        {s}
                      </span>
                    ))}
                    {e.shows.length > 4 && <span className="self-center text-[12px] text-secondary">+{e.shows.length - 4} more</span>}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function Stat({ icon, label }: { icon: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-semibold text-on-surface">
      <Icon name={icon} size={15} className="text-primary" /> {label}
    </span>
  )
}

function EmptyState() {
  return (
    <div className="grid place-items-center gap-sm rounded-2xl border border-dashed border-outline-variant bg-surface-container-low py-[14vh] text-center">
      <Icon name="history" size={32} className="text-outline" />
      <h3 className="text-display-sm text-on-surface-variant">No weekly editions yet</h3>
      <p className="max-w-md text-body-md text-secondary">
        Each week with analysed episodes becomes its own edition here. Once a few episodes are summarised, your history starts
        building automatically — drawn entirely from real content.
      </p>
      <Link
        to="/episodes"
        className="press mt-1 inline-flex items-center gap-2 rounded-lg bg-primary px-lg py-2.5 text-metadata font-semibold text-on-primary hover:bg-primary-container"
      >
        <Icon name="play_circle" size={18} /> Go to Episodes
      </Link>
    </div>
  )
}

function LoadingState() {
  return (
    <ol className="relative ml-2 border-l border-outline-variant">
      {[0, 1, 2].map((i) => (
        <li key={i} className="relative mb-4 pl-6">
          <span className="absolute -left-[7px] top-5 h-3 w-3 rounded-full border-2 border-outline bg-surface" />
          <div className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-md shadow-card">
            <div className="h-4 w-40 rounded bg-surface-container-low motion-safe:animate-pulse" />
            <div className="mt-2 h-3 w-3/4 rounded bg-surface-container-low motion-safe:animate-pulse" />
            <div className="mt-3 h-3 w-1/2 rounded bg-surface-container-low motion-safe:animate-pulse" />
          </div>
        </li>
      ))}
    </ol>
  )
}
