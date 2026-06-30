import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAppData } from '../store/AppData'
import { longDate } from '../lib/format'
import { findExcerpts, tokenizeQuery, topTopics } from '../lib/topics'
import type { Episode } from '../lib/types'
import { CoverTile } from '../components/CoverTile'
import { Icon } from '../components/Icon'
import { StatusBadge } from '../components/StatusBadge'
import { SectionLabel } from '../components/SectionLabel'

export default function Search() {
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const { episodes, podcasts, podcastById } = useAppData()

  const needle = q.trim().toLowerCase()
  const tokens = useMemo(() => tokenizeQuery(q), [q])

  const results = useMemo(() => {
    if (!needle) return null

    // Token-aware match (so "Power & the grid" hits "power" / "grid"); falls back
    // to substring when the query has no significant tokens (e.g. "AI").
    const match = (s: string) => {
      const t = s.toLowerCase()
      return tokens.length ? tokens.some((tok) => t.includes(tok)) : t.includes(needle)
    }

    // Real transcript passages — the headline result.
    const excerpts = findExcerpts(episodes, q, 15)
    const excerptEpisodeIds = new Set(excerpts.map((e) => e.episode.id))

    const eps = episodes.filter(
      (e) =>
        match(e.title) ||
        match(e.blurb) ||
        e.entities.people.some(match) ||
        e.entities.companies.some(match) ||
        e.entities.themes.some(match) ||
        (e.summary?.synthesis.some(match) ?? false),
    )

    const pods = podcasts.filter((p) => match(p.title) || match(p.author) || match(p.description) || match(p.category))

    const entitySet = (pick: (e: Episode) => string[]) => {
      const counts = new Map<string, number>()
      episodes.forEach((e) => pick(e).forEach((v) => match(v) && counts.set(v, (counts.get(v) ?? 0) + 1)))
      return [...counts.entries()].sort((a, b) => b[1] - a[1])
    }
    const people = entitySet((e) => e.entities.people)
    const companies = entitySet((e) => e.entities.companies)
    const themes = entitySet((e) => e.entities.themes)

    const highlights = episodes.flatMap((e) =>
      (e.summary?.highlights ?? [])
        .filter((h) => match(h.title) || match(h.detail))
        .map((h) => ({ episode: e, highlight: h })),
    )

    return { excerpts, excerptEpisodeIds, eps, pods, people, companies, themes, highlights }
  }, [needle, tokens, episodes, podcasts, q])

  const suggestions = useMemo(() => topTopics(episodes, 8), [episodes])
  const anything = results && (results.excerpts.length || results.eps.length || results.pods.length || results.highlights.length || results.people.length || results.companies.length || results.themes.length)

  return (
    <div className="mx-auto max-w-reading animate-fade-up">
      <h2 className="mb-md text-display-lg text-on-background">Search</h2>

      <div className="relative mb-lg">
        <Icon name="search" size={22} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-outline" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setParams(e.target.value ? { q: e.target.value } : {}, { replace: true })}
          placeholder="A topic, company, person, or anything said on an episode…"
          className="w-full rounded-xl border border-outline-variant bg-surface-container-lowest py-3.5 pl-12 pr-4 text-body-lg outline-none focus:border-primary focus:ring-1 focus:ring-primary"
        />
      </div>

      {/* Empty state → real topic suggestions */}
      {!needle && (
        <div>
          <SectionLabel className="mb-sm">Topics from your episodes</SectionLabel>
          {suggestions.length ? (
            <div className="flex flex-wrap gap-sm">
              {suggestions.map((t) => (
                <button
                  key={t.label}
                  onClick={() => setParams({ q: t.label })}
                  className="press inline-flex items-center gap-1.5 rounded-full border border-outline-variant bg-surface px-md py-2 text-metadata text-on-surface hover:border-primary hover:text-primary"
                >
                  <Icon name="tag" size={15} /> {t.label}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-body-md text-secondary">Once episodes are analysed, their topics show up here.</p>
          )}
        </div>
      )}

      {results && (
        <>
          {/* Transcript excerpts — the headline: where the topic is actually discussed */}
          {results.excerpts.length > 0 && (
            <section className="mb-xl">
              <div className="mb-sm flex items-baseline justify-between gap-sm">
                <SectionLabel>Heard on the podcasts</SectionLabel>
                <span className="text-metadata text-secondary">
                  {results.excerpts.length} passage{results.excerpts.length === 1 ? '' : 's'} · {results.excerptEpisodeIds.size}{' '}
                  episode{results.excerptEpisodeIds.size === 1 ? '' : 's'}
                </span>
              </div>
              <div className="space-y-sm">
                {results.excerpts.map((ex) => {
                  const podcast = podcastById(ex.episode.podcastId)
                  return (
                    <Link
                      key={`${ex.episode.id}-${ex.segment.id}`}
                      to={`/episodes/${ex.episode.id}?tab=transcript`}
                      className="lift group block rounded-xl border border-outline-variant bg-surface-container-lowest p-md hover:shadow-card"
                    >
                      {/* Provenance */}
                      <div className="mb-2.5 flex items-center gap-2.5">
                        {podcast && <CoverTile podcast={podcast} className="h-8 w-8 shrink-0" />}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-metadata font-semibold text-on-surface">{podcast?.title ?? 'Podcast'}</p>
                          <p className="truncate text-[12px] text-secondary">
                            {ex.episode.title} · {longDate(ex.episode.publishedAt)}
                          </p>
                        </div>
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-md chip-signal px-2 py-1 text-[12px] font-semibold">
                          <Icon name="schedule" size={13} /> {ex.segment.timestamp}
                        </span>
                      </div>
                      {/* The passage */}
                      <p className="border-l-2 border-primary/30 pl-3 text-body-md leading-relaxed text-on-surface">
                        {ex.segment.speaker && <span className="font-semibold text-on-surface-variant">{ex.segment.speaker}: </span>}
                        <Highlight text={ex.segment.text} terms={ex.matched} />
                      </p>
                      <p className="mt-2 inline-flex items-center gap-1 text-metadata font-semibold text-primary">
                        Open in transcript
                        <Icon name="arrow_forward" size={14} className="transition-transform group-hover:translate-x-0.5" />
                      </p>
                    </Link>
                  )
                })}
              </div>
            </section>
          )}

          {/* Mentions */}
          {(results.people.length > 0 || results.companies.length > 0 || results.themes.length > 0) && (
            <section className="mb-xl">
              <SectionLabel className="mb-sm">Mentions</SectionLabel>
              <div className="flex flex-wrap gap-sm">
                {[
                  ...results.people.map((e) => ['person', e] as const),
                  ...results.companies.map((e) => ['domain', e] as const),
                  ...results.themes.map((e) => ['tag', e] as const),
                ].map(([icon, [name, count]]) => (
                  <button
                    key={name}
                    onClick={() => setParams({ q: name })}
                    className="press inline-flex items-center gap-1.5 rounded-full border border-outline-variant bg-surface px-3 py-1.5 text-metadata text-on-surface hover:border-primary hover:text-primary"
                  >
                    <Icon name={icon} size={15} className="text-secondary" />
                    {name}
                    <span className="text-[12px] text-secondary">{count}</span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* Episodes */}
          {results.eps.length > 0 && (
            <section className="mb-xl">
              <SectionLabel className="mb-sm">Episodes · {results.eps.length}</SectionLabel>
              <div className="overflow-hidden rounded-2xl border border-outline-variant bg-surface-container-lowest">
                {results.eps.map((ep) => {
                  const podcast = podcastById(ep.podcastId)
                  return (
                    <Link
                      key={ep.id}
                      to={`/episodes/${ep.id}`}
                      className="flex items-center gap-md border-b border-outline-variant p-sm transition-colors last:border-b-0 hover:bg-surface-container-low"
                    >
                      {podcast && <CoverTile podcast={podcast} className="h-11 w-11 shrink-0" />}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-body-md font-semibold text-on-surface">{ep.title}</p>
                        <p className="truncate text-metadata text-secondary">
                          {podcast?.title} · {longDate(ep.publishedAt)}
                        </p>
                      </div>
                      <StatusBadge status={ep.status} compact />
                    </Link>
                  )
                })}
              </div>
            </section>
          )}

          {/* Podcasts */}
          {results.pods.length > 0 && (
            <section className="mb-xl">
              <SectionLabel className="mb-sm">Podcasts · {results.pods.length}</SectionLabel>
              <div className="grid grid-cols-1 gap-sm sm:grid-cols-2">
                {results.pods.map((p) => (
                  <Link
                    key={p.id}
                    to="/discover"
                    className="lift flex items-center gap-md rounded-xl border border-outline-variant bg-surface-container-lowest p-sm hover:shadow-card"
                  >
                    <CoverTile podcast={p} className="h-11 w-11 shrink-0" showSource />
                    <div className="min-w-0">
                      <p className="truncate text-body-md font-semibold text-on-surface">{p.title}</p>
                      <p className="truncate text-metadata text-secondary">{p.category}</p>
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {/* Highlights */}
          {results.highlights.length > 0 && (
            <section className="mb-xl">
              <SectionLabel className="mb-sm">Highlights · {results.highlights.length}</SectionLabel>
              <div className="space-y-sm">
                {results.highlights.map(({ episode, highlight }) => (
                  <Link
                    key={highlight.id}
                    to={`/episodes/${episode.id}?tab=highlights`}
                    className="lift block rounded-xl border border-outline-variant bg-surface-container-lowest p-md hover:shadow-card"
                  >
                    <div className="mb-1 flex items-center justify-between gap-sm">
                      <p className="text-metadata font-bold text-on-surface">{highlight.title}</p>
                      <span className="shrink-0 rounded bg-surface-container-high px-2 py-0.5 text-label-caps text-on-surface-variant">
                        {highlight.timestamp}
                      </span>
                    </div>
                    <p className="text-[14px] leading-relaxed text-on-surface-variant">{highlight.detail}</p>
                    <p className="mt-1.5 text-[12px] text-secondary">{podcastById(episode.podcastId)?.title}</p>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {/* Honest empty result — no fake data */}
          {!anything && (
            <div className="grid place-items-center gap-sm py-xl text-center">
              <Icon name="search_off" size={32} className="text-outline" />
              <p className="text-body-md text-secondary">
                Nothing in your analysed episodes mentions “{q}” yet.
              </p>
              <p className="max-w-md text-metadata text-secondary">
                Excerpts appear once an episode covering this has been transcribed and summarised.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// Wrap matched terms in the passage with a soft highlight so the eye lands on them.
function Highlight({ text, terms }: { text: string; terms: string[] }): ReactNode {
  if (!terms.length) return text
  const re = new RegExp(`(${terms.map(escapeRe).join('|')})`, 'gi')
  const parts = text.split(re)
  return (
    <>
      {parts.map((part, i) =>
        terms.some((t) => t.toLowerCase() === part.toLowerCase()) ? (
          <mark key={i} className="rounded bg-[rgba(37,99,235,0.14)] px-0.5 font-semibold text-on-surface">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  )
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
