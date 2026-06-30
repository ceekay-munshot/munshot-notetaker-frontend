import type { Episode, TranscriptSegment } from './types'

// ─────────────────────────────────────────────────────────────────────────────
// Topic intelligence — derived from REAL episode data, never hardcoded.
//
//   topTopics()   → the most-mentioned themes/companies across ready episodes,
//                   so every topic chip is backed by an actual analysed episode.
//   findExcerpts()→ the real transcript lines where a topic is discussed, with
//                   the episode + timestamp they came from.
//
// A topic chip therefore always leads somewhere: clicking it surfaces the exact
// passages it was drawn from.
// ─────────────────────────────────────────────────────────────────────────────

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'to', 'for', 'is', 'are', 'was', 'were', 'be', 'been',
  'with', 'at', 'by', 'as', 'vs', 'from', 'this', 'that', 'it', 'its', 'into', 'about', 'over', 'than',
])

/** Break a query/topic into meaningful, searchable terms (drops punctuation + stopwords). */
export function tokenizeQuery(q: string): string[] {
  return [
    ...new Set(
      q
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length >= 3 && !STOP.has(t)),
    ),
  ]
}

export interface Topic {
  label: string
  count: number
}

/** Most-mentioned topics across ready episodes — real themes + companies, frequency-ranked. */
export function topTopics(episodes: Episode[], limit = 6): Topic[] {
  const counts = new Map<string, Topic>()
  for (const e of episodes) {
    if (e.status !== 'ready') continue
    const labels = [...(e.entities?.themes ?? []), ...(e.entities?.companies ?? [])]
    for (const raw of labels) {
      const label = raw.trim()
      if (label.length < 2) continue
      const key = label.toLowerCase()
      const cur = counts.get(key)
      if (cur) cur.count++
      else counts.set(key, { label, count: 1 })
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, limit)
}

export interface Excerpt {
  episode: Episode
  segment: TranscriptSegment
  /** Which query terms this passage actually contains. */
  matched: string[]
  score: number
}

/** Real transcript passages discussing a topic, ranked by how many query terms they hit. */
export function findExcerpts(episodes: Episode[], query: string, limit = 30): Excerpt[] {
  const tokens = tokenizeQuery(query)
  if (!tokens.length) return []
  const out: Excerpt[] = []
  for (const e of episodes) {
    if (!e.transcript?.length) continue
    for (const segment of e.transcript) {
      const text = segment.text.toLowerCase()
      const matched = tokens.filter((t) => text.includes(t))
      if (!matched.length) continue
      // Distinct terms hit, with a small bonus for a longer, substantive passage.
      const score = matched.length * 10 + Math.min(segment.text.length / 200, 1)
      out.push({ episode: e, segment, matched, score })
    }
  }
  out.sort((a, b) => b.score - a.score || +new Date(b.episode.publishedAt) - +new Date(a.episode.publishedAt))
  return out.slice(0, limit)
}

/**
 * Best transcript segment to anchor a summary point (e.g. a takeaway) to, by
 * distinct significant-term overlap. Returns null when nothing matches well
 * enough, so a takeaway only becomes clickable when there's a genuinely
 * relevant passage to jump to — never a misleading dead-end.
 */
export function anchorSegment(text: string, segments: TranscriptSegment[] | undefined): string | null {
  if (!segments?.length) return null
  const tokens = tokenizeQuery(text)
  if (tokens.length < 2) return null
  let bestId: string | null = null
  let best = 0
  for (const seg of segments) {
    const t = seg.text.toLowerCase()
    let score = 0
    for (const tok of tokens) if (t.includes(tok)) score++
    if (score > best) {
      best = score
      bestId = seg.id
    }
  }
  // Require at least two distinct shared terms so the jump lands somewhere real.
  return best >= 2 ? bestId : null
}

/** Trim a long passage to a readable window centred on the first matched term. */
export function excerptWindow(text: string, terms: string[], radius = 160): string {
  if (text.length <= radius * 2) return text
  const lower = text.toLowerCase()
  let idx = -1
  let matchLen = 0
  for (const t of terms) {
    const i = lower.indexOf(t)
    if (i !== -1 && (idx === -1 || i < idx)) {
      idx = i
      matchLen = t.length
    }
  }
  if (idx === -1) return text.slice(0, radius * 2).trimEnd() + '…'
  let start = Math.max(0, idx - radius)
  let end = Math.min(text.length, idx + matchLen + radius)
  // Expand OUTWARD to whole words so the snap can never cross (and drop) the matched
  // term: leftward from start, rightward from end. The previous indexOf/lastIndexOf
  // pair searched toward the term and could leap past it, omitting the very word the
  // window is meant to centre on.
  if (start > 0) {
    const sp = text.lastIndexOf(' ', start)
    start = sp === -1 ? 0 : sp + 1
  }
  if (end < text.length) {
    const sp = text.indexOf(' ', end)
    if (sp !== -1) end = sp
  }
  return `${start > 0 ? '… ' : ''}${text.slice(start, end).trim()}${end < text.length ? ' …' : ''}`
}
