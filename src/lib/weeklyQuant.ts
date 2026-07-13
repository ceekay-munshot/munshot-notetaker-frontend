import type { QuantPoint, WeeklyCitation } from './types'

// ─────────────────────────────────────────────────────────────────────────────
// Group the weekly Quantitative Summary by the episode each row came from.
//
// The flat table mixes numbers from every episode of the week (Holcim sales next
// to GameStop revenue next to Amazon water use) with only a bare "[1]/[2]/[3]"
// to tell them apart — which reads as one nonsensical list. Each row carries that
// citation marker, and `weekly.citations` maps [n] → the episode ("Show — Title"),
// so we can resolve every row to its source and render the table per-episode with
// a clear heading. The marker is stripped from the cells (the heading attributes
// them). Uncited rows fall into a trailing "Across sources" group; if NOTHING is
// cited, a single header-less group is returned so the table renders flat as before.
// ─────────────────────────────────────────────────────────────────────────────

export interface QuantGroup {
  /** Episode heading ("Show — Title"); '' means render the rows with no heading. */
  label: string
  episodeId?: string
  rows: QuantPoint[]
}

const CITE_RE = /\[(\d+)\]/
const ALL_CITES_RE = /\s*\[\d+\]/g

/** First `[n]` anywhere in the row (context, then value, then metric), or null. */
function firstCitation(q: QuantPoint): number | null {
  const m = `${q.context} ${q.value} ${q.metric}`.match(CITE_RE)
  return m ? Number(m[1]) : null
}

/** Drop citation markers + tidy whitespace — the group heading does the attribution. */
function stripCitations(s: string): string {
  return s.replace(ALL_CITES_RE, '').replace(/\s{2,}/g, ' ').trim()
}

export function groupQuantByEpisode(quant: QuantPoint[], citations: WeeklyCitation[] = []): QuantGroup[] {
  const byIndex = new Map(citations.map((c) => [c.index, c]))
  const UNCITED = '__uncited__'
  const groups = new Map<string, QuantGroup & { sort: number }>()

  for (const q of quant) {
    const n = firstCitation(q)
    const cite = n != null ? byIndex.get(n) : undefined
    const key = cite?.episodeId ?? UNCITED
    let g = groups.get(key)
    if (!g) {
      g = { label: cite?.label ?? 'Across sources', episodeId: cite?.episodeId, rows: [], sort: cite ? cite.index : Number.MAX_SAFE_INTEGER }
      groups.set(key, g)
    }
    g.rows.push({ metric: stripCitations(q.metric), value: stripCitations(q.value), context: stripCitations(q.context) })
  }

  const out = [...groups.values()]
    .sort((a, b) => a.sort - b.sort)
    .map(({ sort: _sort, ...g }) => g)

  // Nothing was attributable → one header-less group, i.e. the original flat table.
  if (out.length === 1 && !out[0].episodeId) out[0].label = ''
  return out
}
