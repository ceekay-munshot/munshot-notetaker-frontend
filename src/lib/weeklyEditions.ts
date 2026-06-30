import type { Episode, Podcast } from './types'
import { isoWeekKey, isoWeekRange, weekRangeLabel } from './format'
import { keyHighlights } from './highlights'

// ─────────────────────────────────────────────────────────────────────────────
// Weekly EDITIONS — the history layer. The weekly digest itself is built by
// generateWeekly() from an arbitrary episode subset; here we slice the ready
// episodes into per-ISO-week buckets so every past week becomes its own edition.
//
// Everything in this module is deterministic (no AI, no network), so the archive
// list and the edition switcher render instantly. Opening an edition is what runs
// the (cached) generateWeekly pass for that week's episodes.
// ─────────────────────────────────────────────────────────────────────────────

type ById = (id: string) => Podcast | undefined

export interface WeeklyEditionMeta {
  /** ISO-week bucket key, e.g. "2026-W23". */
  weekKey: string
  /** Canonical Mon–Sun label, e.g. "Jun 1 – 7, 2026". */
  rangeLabel: string
  episodeIds: string[]
  episodeCount: number
  /** Total concrete ideas pitched across the week (for the card stat). */
  ideaCount: number
  /** Show names, most-episodes first. */
  shows: string[]
  /** A concrete one-liner for the card — never generic filler. */
  headline: string
}

const readyEpisodes = (episodes: Episode[]): Episode[] => episodes.filter((e) => e.status === 'ready' && !!e.summary)

// High-signal first, then newest-first — the lead episode drives the headline.
const bySignalThenRecency = (a: Episode, b: Episode): number =>
  (b.signal === 'high' ? 1 : 0) - (a.signal === 'high' ? 1 : 0) || +new Date(b.publishedAt) - +new Date(a.publishedAt)

/** Group ready episodes into per-week editions, newest week first. */
export function listEditions(episodes: Episode[], podcastById: ById): WeeklyEditionMeta[] {
  const byWeek = new Map<string, Episode[]>()
  for (const e of readyEpisodes(episodes)) {
    const k = isoWeekKey(e.publishedAt)
    const arr = byWeek.get(k) ?? []
    arr.push(e)
    byWeek.set(k, arr)
  }

  const editions: WeeklyEditionMeta[] = []
  for (const [weekKey, eps] of byWeek) {
    const sorted = [...eps].sort(bySignalThenRecency)
    const { start, end } = isoWeekRange(sorted[0].publishedAt)
    editions.push({
      weekKey,
      rangeLabel: weekRangeLabel(start, end),
      episodeIds: sorted.map((e) => e.id),
      episodeCount: sorted.length,
      ideaCount: sorted.reduce((n, e) => n + (e.summary?.ideas?.length ?? 0), 0),
      shows: topShows(sorted, podcastById),
      headline: editionHeadline(sorted),
    })
  }

  // Newest week first — weekKey sorts chronologically (year prefix + padded week).
  return editions.sort((a, b) => (a.weekKey < b.weekKey ? 1 : a.weekKey > b.weekKey ? -1 : 0))
}

/** The ready-episode ids belonging to a given week bucket (the reader resolves
 *  these back to Episodes and feeds them to generateWeekly). */
export function editionEpisodeIds(episodes: Episode[], weekKey: string): string[] {
  return readyEpisodes(episodes)
    .filter((e) => isoWeekKey(e.publishedAt) === weekKey)
    .map((e) => e.id)
}

function topShows(eps: Episode[], podcastById: ById): string[] {
  const counts = new Map<string, number>()
  for (const e of eps) {
    const name = podcastById(e.podcastId)?.title ?? 'Unknown show'
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name)
}

// A specific, concrete line for the card: the week's first pitched idea, else the
// lead episode's first key highlight, else the lead episode title. Never generic.
function editionHeadline(sorted: Episode[]): string {
  for (const e of sorted) {
    const idea = e.summary?.ideas?.[0]
    if (idea) {
      const who = idea.proponent && idea.proponent !== '—' ? ` — ${idea.proponent}` : ''
      return `${idea.idea}${who}`.replace(/\*\*/g, '')
    }
  }
  const lead = sorted[0]
  const hl = lead.summary ? keyHighlights(lead.summary)[0] : undefined
  return (hl?.title ?? lead.title).replace(/\*\*/g, '').trim()
}
