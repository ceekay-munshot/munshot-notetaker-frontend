import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppData } from '../store/AppData'
import { searchPodcasts } from '../lib/api'
import type { Podcast, PodcastSearchResult } from '../lib/types'
import { stableHash } from '../lib/hash'
import { CoverTile } from '../components/CoverTile'
import { Icon } from '../components/Icon'

// Cover palette for results with no artwork (e.g. YouTube channels). Deterministic
// per result so the same show always gets the same color.
const PALETTE = ['#0058bc', '#1c7d52', '#b3541e', '#5b3fa8', '#0a6e6e', '#1f3a8a', '#635bff', '#2f6f4f', '#d83b3b', '#e0792b']

function monogramOf(title: string): string {
  const words = title.replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean)
  if (!words.length) return 'PC'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

// Search hit → a full Podcast the store can track (and CoverTile can render).
function toPodcast(r: PodcastSearchResult): Podcast {
  return {
    id: r.id,
    title: r.title,
    author: r.author,
    category: r.category,
    description: r.description,
    cadence: '',
    episodeCount: 0,
    source: r.source,
    color: PALETTE[parseInt(stableHash(r.id), 36) % PALETTE.length],
    monogram: monogramOf(r.title),
    artworkUrl: r.artworkUrl,
    feedUrl: r.feedUrl,
    tracked: true,
  }
}

const trimFeed = (u?: string) => (u ? u.trim().toLowerCase().replace(/\/+$/, '') : '')

export default function Discover() {
  const { podcasts, toggleTracked, addPodcast } = useAppData()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<PodcastSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState(false)
  const [justAdded, setJustAdded] = useState<string | null>(null)

  const tracked = podcasts.filter((p) => p.tracked && !p.locked)
  const q = query.trim()

  // Live, debounced directory search. Each keystroke aborts the previous request,
  // so a slow earlier response can never overwrite a newer query's results.
  useEffect(() => {
    if (!q) {
      setResults([])
      setSearching(false)
      setError(false)
      return
    }
    setSearching(true)
    setError(false)
    const controller = new AbortController()
    const timer = setTimeout(() => {
      searchPodcasts(q, controller.signal)
        .then((r) => {
          setResults(r)
          setSearching(false)
        })
        .catch((err) => {
          if ((err as { name?: string })?.name === 'AbortError') return // superseded — keep newer results
          setError(true)
          setSearching(false)
        })
    }, 300)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [q])

  // Already in the user's list? (by id or the same feed) → show as tracked.
  const isTracked = (r: PodcastSearchResult) =>
    podcasts.some((p) => p.tracked && (p.id === r.id || (!!p.feedUrl && trimFeed(p.feedUrl) === trimFeed(r.feedUrl))))

  function onAdd(r: PodcastSearchResult) {
    addPodcast(toPodcast(r))
    setJustAdded(r.title)
  }

  // ── Suggestions — one pool the user can page through "infinitely" ───────────
  // Untracked catalog shows first (category-overlap ranked), then directory
  // results for the categories the user picked. "See more" pages through the
  // pool and, once it runs dry, queries the next categories (cached per
  // category, so toggling shows never refetches). Everything dedupes at render
  // time against the catalog + selection, so a pick instantly drops out.
  const allCats = useMemo(() => {
    const counts = new Map<string, number>()
    for (const p of tracked)
      for (const c of p.category.split('·').map((s) => s.trim()).filter(Boolean)) counts.set(c, (counts.get(c) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c)
  }, [tracked.map((p) => p.id).join(',')]) // eslint-disable-line react-hooks/exhaustive-deps

  const [catCount, setCatCount] = useState(2) // categories queried so far
  const [visible, setVisible] = useState(6) // suggestion cards shown
  const queryCats = allCats.slice(0, catCount)
  const queryKey = queryCats.join('|')

  const relCache = useRef(new Map<string, PodcastSearchResult[]>())
  const [relatedRaw, setRelatedRaw] = useState<PodcastSearchResult[]>([])
  const [relatedLoading, setRelatedLoading] = useState(false)

  useEffect(() => {
    if (!queryKey) {
      setRelatedRaw([])
      return
    }
    const cats = queryKey.split('|')
    const controller = new AbortController()
    let stale = false // a superseded run must not clobber the newer run's state
    const allCached = cats.every((c) => relCache.current.has(c))
    if (!allCached) setRelatedLoading(true)
    Promise.all(
      cats.map(
        (c) =>
          relCache.current.get(c) ??
          searchPodcasts(c, controller.signal, 50)
            .then((r) => {
              if (r.length) relCache.current.set(c, r) // don't cache an empty result — a transient failure also resolves [], and caching it would hide the category for the whole session
              return r
            })
            .catch(() => [] as PodcastSearchResult[]), // aborted / unavailable → just no suggestions
      ),
    ).then((lists) => {
      if (stale) return
      // Round-robin interleave so every picked category is represented up top.
      const merged: PodcastSearchResult[] = []
      for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (l[i]) merged.push(l[i])
      setRelatedRaw(merged)
      setRelatedLoading(false)
    })
    return () => {
      stale = true
      controller.abort()
    }
  }, [queryKey])

  type Suggestion = { key: string; podcast: Podcast; add: () => void }
  const suggestions = useMemo<Suggestion[]>(() => {
    const pickCats = new Set(allCats)
    const overlap = (p: Podcast) => p.category.split('·').map((s) => s.trim()).filter((c) => pickCats.has(c)).length
    // Curated catalog shows the user hasn't picked (locked ones can't be tracked).
    const seeds: Suggestion[] = podcasts
      .filter((p) => !p.tracked && !p.locked)
      .sort((a, b) => overlap(b) - overlap(a))
      .map((p) => ({ key: p.id, podcast: p, add: () => toggleTracked(p.id) }))
    const seenIds = new Set(podcasts.map((p) => p.id))
    const seenFeeds = new Set(podcasts.map((p) => trimFeed(p.feedUrl)).filter(Boolean))
    const dir: Suggestion[] = []
    for (const r of relatedRaw) {
      const feed = trimFeed(r.feedUrl)
      if (seenIds.has(r.id) || (feed && seenFeeds.has(feed)) || isTracked(r)) continue
      seenIds.add(r.id)
      if (feed) seenFeeds.add(feed)
      dir.push({ key: r.id, podcast: { ...toPodcast(r), tracked: false }, add: () => onAdd(r) })
    }
    return [...seeds, ...dir]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [podcasts, relatedRaw, allCats])

  // Page through the pool; when it runs dry, pull the next categories from the
  // directory so there's always more to choose from.
  const morePoolLeft = suggestions.length > visible
  const moreCatsLeft = catCount < allCats.length
  function onSeeMore() {
    setVisible((v) => v + 8)
    if (visible + 8 >= suggestions.length && moreCatsLeft) setCatCount((c) => c + 2)
  }

  return (
    // The fixed dock must NOT live inside the entrance animation: `fade-up`'s
    // persistent transform (fill-mode: both) turns the wrapper into the containing
    // block for position:fixed, pinning the dock to the page instead of the
    // viewport — the exact misalignment the old selected-bar suffered.
    <div className="pb-24 lg:pb-0">
      <div className="animate-fade-up lg:grid lg:grid-cols-12 lg:gap-gutter">
        {/* ── Main column ───────────────────────────────────────────────────── */}
        <div className="lg:col-span-8">
          {/* Heading + search */}
          <div className="mx-auto max-w-3xl text-center">
            <h1 className="text-display-lg tracking-tight text-on-surface">Track the podcasts that matter to you</h1>
            <p className="mt-2 text-body-lg text-secondary">
              Search Apple Podcasts, or paste an RSS feed, YouTube channel, or playlist URL to get started.
            </p>
            <form onSubmit={(e: FormEvent) => e.preventDefault()} className="relative mx-auto mt-lg">
              <Icon name="search" size={22} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-outline" />
              <input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setJustAdded(null)
                }}
                placeholder="Search podcasts or paste an RSS / YouTube channel / playlist URL"
                className="w-full rounded-xl border border-outline-variant bg-surface-container-lowest py-3.5 pl-12 pr-11 text-body-md shadow-card outline-none focus:border-primary"
                autoFocus
              />
              {searching && (
                <Icon name="progress_activity" size={20} className="absolute right-4 top-1/2 -translate-y-1/2 animate-spin text-outline" />
              )}
            </form>
            {justAdded && (
              <p className="mt-sm inline-flex items-center gap-1.5 rounded-lg chip-signal px-3 py-2 text-metadata font-medium">
                <Icon name="check_circle" size={16} fill /> Tracking <span className="font-semibold">{justAdded}</span> — we'll detect new
                episodes.
              </p>
            )}
          </div>

          {/* Search results */}
          {q && (
            <div className="mt-xl">
              <h3 className="mb-md text-[19px] font-semibold text-on-surface">Search results</h3>
              {searching && results.length === 0 ? (
                <CardSkeletons />
              ) : error ? (
                <div className="rounded-xl border border-dashed border-outline-variant bg-surface-container-low p-lg text-center">
                  <p className="text-body-md text-on-surface-variant">Search is unavailable right now. Please try again in a moment.</p>
                </div>
              ) : results.length === 0 ? (
                <div className="rounded-xl border border-dashed border-outline-variant bg-surface-container-low p-lg text-center">
                  <p className="text-body-md text-on-surface">
                    No podcasts found for <span className="font-semibold">“{q}”</span>.
                  </p>
                  <p className="mt-1 text-metadata text-secondary">Try a different name, or paste an RSS feed, YouTube channel, or playlist URL.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-gutter md:grid-cols-2">
                  {results.map((r) => {
                    const trackedNow = isTracked(r)
                    return (
                      <PodcastCard
                        key={r.id}
                        podcast={{ ...toPodcast(r), tracked: trackedNow }}
                        onToggle={() => {
                          if (!trackedNow) onAdd(r)
                        }}
                      />
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* Suggestions — already-picked shows never appear here; remove them
              from the rail on the right instead. */}
          {(suggestions.length > 0 || relatedLoading) && (
            <div className="mt-xl">
              <h3 className="text-[19px] font-semibold text-on-surface">
                {tracked.length ? 'More like your picks' : 'Suggested shows'}
              </h3>
              <p className="mb-md mt-0.5 text-metadata text-secondary">
                {tracked.length && queryCats.length
                  ? `From the directory, based on the categories you follow — ${queryCats.join(', ')}.`
                  : 'A few strong starting points — or search above.'}
              </p>
              {relatedLoading && suggestions.length === 0 ? (
                <CardSkeletons />
              ) : (
                <div className="grid grid-cols-1 gap-gutter md:grid-cols-2">
                  {suggestions.slice(0, visible).map((s) => (
                    <PodcastCard key={s.key} podcast={s.podcast} onToggle={s.add} />
                  ))}
                </div>
              )}
              {morePoolLeft || moreCatsLeft || relatedLoading ? (
                <button
                  onClick={onSeeMore}
                  disabled={relatedLoading && !morePoolLeft}
                  className="press mx-auto mt-md flex items-center gap-2 rounded-lg border border-outline-variant bg-surface px-lg py-2.5 text-metadata font-semibold text-on-surface hover:bg-surface-container-low disabled:opacity-60"
                >
                  {relatedLoading && !morePoolLeft ? (
                    <Icon name="progress_activity" size={17} className="animate-spin" />
                  ) : (
                    <Icon name="expand_more" size={18} />
                  )}
                  See more
                </button>
              ) : visible > 6 ? (
                // The well is dry — say so instead of the button silently vanishing.
                <p className="mt-md text-center text-metadata text-secondary">
                  That's every suggestion we have for now — search above for anything specific.
                </p>
              ) : null}
            </div>
          )}
        </div>

        {/* ── Selection rail (desktop) ──────────────────────────────────────── */}
        <aside className="hidden lg:col-span-4 lg:block">
          <div className="sticky top-20 flex max-h-[calc(100vh-6.5rem)] flex-col overflow-hidden rounded-2xl border border-outline-variant bg-surface-container-lowest shadow-card">
            <div className="border-b border-outline-variant p-md">
              <div className="flex items-center gap-2">
                <h2 className="text-[17px] font-semibold text-on-surface">Your podcasts</h2>
                {tracked.length > 0 && (
                  <span className="grid h-5 min-w-5 place-items-center rounded-full chip-signal px-1.5 text-[11px] font-bold">
                    {tracked.length}
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-metadata text-secondary">New episodes are detected automatically.</p>
            </div>

            {tracked.length === 0 ? (
              <div className="grid place-items-center gap-1 px-md py-xl text-center">
                <Icon name="playlist_add" size={28} className="text-outline" />
                <p className="text-[14px] font-medium text-on-surface-variant">Nothing tracked yet</p>
                <p className="text-metadata text-secondary">Pick a few shows to build your feed.</p>
              </div>
            ) : (
              <ul className="flex-1 overflow-y-auto p-2">
                {tracked.map((p) => (
                  <li key={p.id}>
                    <div className="group flex items-center gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-surface-container-low">
                      <CoverTile podcast={p} className="h-9 w-9 shrink-0" rounded="rounded-lg" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[14px] font-medium text-on-surface">{p.title}</p>
                        <p className="truncate text-[12px] text-secondary">{p.category}</p>
                      </div>
                      <button
                        onClick={() => toggleTracked(p.id)}
                        aria-label={`Remove ${p.title}`}
                        className="press grid h-7 w-7 shrink-0 place-items-center rounded-md text-outline hover:bg-surface-container hover:text-error"
                      >
                        <Icon name="close" size={16} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {tracked.length > 0 && (
              <div className="border-t border-outline-variant p-md">
                <button
                  onClick={() => navigate('/')}
                  className="press flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-lg py-2.5 text-metadata font-semibold text-on-primary hover:bg-primary-container"
                >
                  Continue <Icon name="arrow_forward" size={18} />
                </button>
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* ── Selection dock (small screens) — one aligned row, never wraps ───── */}
      {tracked.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-outline-variant bg-surface/95 backdrop-blur-xl lg:hidden">
          <div className="flex items-center gap-sm px-md py-3">
            <div className="flex shrink-0 -space-x-2">
              {tracked.slice(0, 4).map((p) => (
                <CoverTile key={p.id} podcast={p} className="h-8 w-8 ring-2 ring-surface" rounded="rounded-lg" />
              ))}
            </div>
            <p className="min-w-0 truncate text-[14px] font-semibold text-on-surface">{tracked.length} tracked</p>
            <button
              onClick={() => navigate('/')}
              className="press ml-auto inline-flex shrink-0 items-center gap-2 rounded-lg bg-primary px-md py-2.5 text-metadata font-semibold text-on-primary hover:bg-primary-container"
            >
              Continue <Icon name="arrow_forward" size={18} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function CardSkeletons() {
  return (
    <div className="grid grid-cols-1 gap-gutter md:grid-cols-2">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-md rounded-xl border border-outline-variant bg-surface-container-lowest p-md">
          <div className="h-16 w-16 shrink-0 animate-pulse rounded-xl bg-surface-container-high" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-4 w-1/2 animate-pulse rounded bg-surface-container-high" />
            <div className="h-3 w-1/4 animate-pulse rounded bg-surface-container-high" />
            <div className="h-3 w-3/4 animate-pulse rounded bg-surface-container-high" />
          </div>
        </div>
      ))}
    </div>
  )
}

function PodcastCard({ podcast, onToggle }: { podcast: Podcast; onToggle: () => void }) {
  // Locked = no public feed. Can't be tracked, ingested, or transcribed — render
  // it plainly as locked rather than letting it imply analyzable content.
  if (podcast.locked) {
    return (
      <div className="flex items-center gap-md rounded-xl border border-dashed border-outline-variant bg-surface-container-low p-md">
        <div className="relative shrink-0">
          <CoverTile podcast={podcast} className="h-16 w-16 opacity-50 grayscale" rounded="rounded-xl" showSource />
          <span className="absolute inset-0 grid place-items-center">
            <Icon name="lock" size={22} className="text-on-surface" />
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h4 className="text-[16px] font-semibold text-on-surface-variant">{podcast.title}</h4>
            <span className="inline-flex items-center gap-1 rounded-full border border-outline-variant px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-secondary">
              <Icon name="lock" size={11} /> Locked
            </span>
          </div>
          <p className="text-[12px] text-secondary">No public feed — episodes can't be ingested or transcribed.</p>
          <p className="mt-0.5 line-clamp-1 text-metadata text-outline">{podcast.description}</p>
        </div>
        <span
          className="grid h-9 w-9 shrink-0 cursor-not-allowed place-items-center rounded-full border border-outline-variant text-outline"
          title="No public feed — can't be tracked"
          aria-label={`${podcast.title} is locked — no public feed`}
        >
          <Icon name="lock" size={18} />
        </span>
      </div>
    )
  }
  const tracked = podcast.tracked
  return (
    <div
      className={`lift flex items-center gap-md rounded-xl border bg-surface-container-lowest p-md hover:shadow-card ${
        tracked ? 'border-primary ring-1 ring-primary/15' : 'border-outline-variant'
      }`}
    >
      <CoverTile podcast={podcast} className="h-16 w-16 shrink-0" rounded="rounded-xl" showSource />
      <div className="min-w-0 flex-1">
        <h4 className="line-clamp-2 text-[16px] font-semibold text-on-surface">{podcast.title}</h4>
        <p className="text-[12px] text-secondary">{podcast.category}</p>
        <p className="mt-0.5 line-clamp-1 text-metadata text-on-surface-variant">{podcast.description || podcast.author}</p>
      </div>
      <button
        onClick={onToggle}
        className={`press grid h-9 w-9 shrink-0 place-items-center rounded-full ${
          tracked ? 'bg-primary text-on-primary' : 'border border-outline-variant text-primary hover:bg-surface-container-low'
        }`}
        aria-label={tracked ? `${podcast.title} is tracked` : `Add ${podcast.title}`}
      >
        <Icon name={tracked ? 'check' : 'add'} size={20} />
      </button>
    </div>
  )
}
