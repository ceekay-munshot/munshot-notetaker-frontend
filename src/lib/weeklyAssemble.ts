import type { Episode, Podcast, QuantPoint, Takeaway, WeeklyAi, WeeklyCitation, WeeklyEpisodeReadout, WeeklyIdea, WeeklyShowDigest, WeeklySource, WeeklySummary, WeeklyTheme } from './types'
import { keyHighlights } from './highlights'
import { topTopics } from './topics'

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic Weekly assembly — the PURE "summary of summaries" engine, shared
// by the client (weeklyApi.ts, which layers caching + an AI narrative on top) and
// the server-side Monday digest (server/weeklyDigest.ts, which has no browser).
//
// Everything here is derived ONLY from the per-episode summaries — no AI, no
// fabrication, no localStorage, no fetch — so it runs identically in the browser,
// in the Vite dev middleware, and in the Cloudflare Worker. Keep it that way.
// ─────────────────────────────────────────────────────────────────────────────

type ById = (id: string) => Podcast | undefined

// Per-show caps — keep each show's digest scannable when it has several episodes.
const SHOW_TAKEAWAYS_CAP = 6
const SHOW_QUESTIONS_CAP = 5

/** Compose the full deterministic WeeklySummary from a set of ready episodes.
 *  Sorts internally (newest-first), so callers don't have to. */
export function assembleWeekly(episodes: Episode[], podcastById: ById, opts: { rangeLabel?: string; id?: string } = {}): WeeklySummary {
  const ready = [...episodes]
    .filter((e) => e.status === 'ready' && e.summary)
    .sort((a, b) => +new Date(b.publishedAt) - +new Date(a.publishedAt))

  const shows = buildShowDigests(ready, podcastById)
  const topThemes = topTopics(ready, 6).map((t) => ({ label: t.label, momentum: t.count }))
  const mentions = aggregateMentions(ready)
  const interesting = pickInteresting(ready, podcastById)
  const range = opts.rangeLabel ?? rangeLabel(ready)
  const overview = derivedOverview(ready, topThemes, podcastById)
  const takeaways = derivedTakeaways(ready)

  // Guidepoint-shaped layers — built deterministically so the no-key path (and the
  // cron without an LLM key) still produces a synthesised-looking edition. The AI
  // layer (weeklyApi / weeklyDigest) OVERWRITES keyThemes/quantTable/episodeReadouts/
  // overview when a key is present, reusing this same citation order so [n] lines up.
  const citations = buildCitations(ready, podcastById)
  const quantTable = aggregateQuant(ready, citations)
  const episodeReadouts = buildEpisodeReadouts(ready, citations, podcastById)
  const keyThemes = derivedKeyThemes(ready, citations)

  const words = [...overview, ...takeaways.flatMap((t) => [t.title, t.detail])].join(' ').trim().split(/\s+/).length
  return {
    id: opts.id ?? `wk-${hashKey(ready)}`,
    rangeLabel: range,
    episodeCount: ready.length,
    readMinutes: Math.max(1, Math.round(words / 200)),
    overview,
    keyThemes,
    quantTable,
    episodeReadouts,
    citations,
    shows,
    topThemes,
    interesting,
    takeaways,
    contradictions: [], // never fabricated — section hidden when empty
    mentions,
    questions: [], // the AI layer (client only) fills these; deterministic base leaves them empty
    sourceEpisodeIds: ready.map((e) => e.id),
  }
}

/** Strip any `[n]` citation marker whose number is outside the registry — the LLM
 *  occasionally cites a source that doesn't exist; never show a dangling marker. */
function clampCitations(s: string, max: number): string {
  return s.replace(/\[(\d+)\]/g, (m, d) => (Number(d) >= 1 && Number(d) <= max ? m : ''))
}

/** Overlay the AI narrative onto the deterministic base — the single merge used by
 *  BOTH the client (weeklyApi) and the server cron (weeklyDigest), so the on-screen
 *  and emailed editions are assembled identically. Falls back field-by-field to the
 *  deterministic layer when the AI omitted something. Reuses `base.citations` as the
 *  canonical [n] map: attaches episodeId to each readout, backfills its episode label,
 *  and strips any out-of-range marker from the prose. */
export function mergeWeeklyAi(base: WeeklySummary, ai: WeeklyAi): WeeklySummary {
  const cites = base.citations ?? []
  const max = cites.length
  const citeByIndex = new Map(cites.map((c) => [c.index, c]))

  const overview = ai.overview.length ? ai.overview.map((p) => clampCitations(p, max)) : base.overview
  const keyThemes = ai.keyThemes.length
    ? ai.keyThemes.map((t) => ({ heading: t.heading, points: t.points.map((p) => clampCitations(p, max)) }))
    : base.keyThemes ?? []
  const quantTable = ai.quantTable.length ? ai.quantTable : base.quantTable
  const episodeReadouts = (ai.episodeReadouts ?? []).length
    ? ai.episodeReadouts.map((r) => {
        const cite = citeByIndex.get(r.index)
        return {
          ...r,
          episodeId: cite?.episodeId ?? r.episodeId,
          episode: r.episode || cite?.label || '',
          evidence: clampCitations(r.evidence, max),
          interpretation: clampCitations(r.interpretation, max),
          action: clampCitations(r.action, max),
        }
      })
    : base.episodeReadouts ?? []
  const questions = ai.questions.length ? ai.questions : base.questions

  const words = [...overview, ...keyThemes.flatMap((t) => [t.heading, ...t.points]), ...episodeReadouts.flatMap((r) => [r.theme, r.evidence, r.interpretation])]
    .join(' ')
    .trim()
    .split(/\s+/).length
  return { ...base, overview, keyThemes, quantTable, episodeReadouts, questions, readMinutes: Math.max(1, Math.round(words / 200)) }
}

// ── Guidepoint-shaped deterministic builders ─────────────────────────────────
// All derived ONLY from the per-episode summaries, in the canonical newest-first
// `ready` order, so the [n] citation numbers are stable and the AI layer can reuse
// the exact same ordering. Exported so weeklyApi/weeklyDigest share one source of
// truth for the citation map + the source payload fed to the LLM.

/** The canonical `[n]` → episode registry: 1-based, in `ready` (newest-first) order. */
export function buildCitations(ready: Episode[], podcastById: ById): WeeklyCitation[] {
  return ready.map((e, i) => ({
    index: i + 1,
    episodeId: e.id,
    label: `${podcastById(e.podcastId)?.title ?? 'Unknown show'} — ${e.title}`,
  }))
}

/** Aggregate the per-episode `quantData` into the weekly Quantitative Summary,
 *  de-duped by metric+value, with the source citation appended to the context. */
export function aggregateQuant(ready: Episode[], citations: WeeklyCitation[]): QuantPoint[] {
  const idxById = new Map(citations.map((c) => [c.episodeId, c.index]))
  const seen = new Set<string>()
  const out: QuantPoint[] = []
  for (const e of ready) {
    const n = idxById.get(e.id)
    for (const q of e.summary?.quantData ?? []) {
      const dedupe = `${q.metric.toLowerCase()}|${q.value.toLowerCase()}`
      if (seen.has(dedupe)) continue
      seen.add(dedupe)
      const cite = n ? ` [${n}]` : ''
      out.push({ metric: q.metric, value: q.value, context: `${q.context}${cite}`.trim() })
      if (out.length >= 16) return out
    }
  }
  return out
}

/** One per-episode Investment Readout — the deterministic fallback (no-LLM path).
 *  Hallucination-free by construction: it only reshuffles fields the per-episode
 *  summary already extracted under its own strict-evidence rules. */
export function buildEpisodeReadouts(ready: Episode[], citations: WeeklyCitation[], podcastById: ById): WeeklyEpisodeReadout[] {
  const idxById = new Map(citations.map((c) => [c.episodeId, c.index]))
  const names = (list?: { name: string }[]) => (list ?? []).map((p) => p.name).filter(Boolean)
  return ready.map((e) => {
    const s = e.summary
    const ins = s?.insight
    const quant = (s?.quantData ?? []).map((q) => `${q.metric}: ${q.value}`).join('; ')
    const lead = s ? keyHighlights(s)[0]?.detail ?? '' : ''
    // Full data — never truncate; the brief shows the whole evidence/interpretation.
    const evidence = [ins?.whatChanged, quant, lead].filter(Boolean).join(' ').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim()
    const namesSectors = [...names(ins?.beneficiaries), ...names(ins?.atRisk), ...(e.entities?.companies ?? [])].filter(Boolean)
    return {
      index: idxById.get(e.id) ?? 0,
      episodeId: e.id,
      episode: `${podcastById(e.podcastId)?.title ?? 'Unknown show'} — ${e.title}`,
      // Prefer the episode's short theme tag for a concise "theme"; fall back to the
      // full development (never cut) so the column is meaningful, not duplicative.
      theme: (e.entities?.themes?.[0] || ins?.whatChanged || e.title).replace(/\*\*/g, '').trim(),
      evidence: evidence || (s?.synthesis?.[0] ?? e.blurb ?? '').replace(/\*\*/g, '').trim(),
      interpretation: (ins?.whyItMatters || '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim(),
      namesSectors: namesSectors.length ? [...new Set(namesSectors)].join(', ') : '—',
      confidence: 'Medium',
      action: (ins?.diligenceQuestions?.[0] ?? '').trim(),
      questionsToVerify: (ins?.diligenceQuestions ?? []).slice(0, 4).map((q) => q.trim()).filter(Boolean),
    }
  })
}

/** A deterministic Key-Points fallback: cluster by top theme, each point a
 *  claim-first highlight with its source citation. Overwritten by the AI layer. */
export function derivedKeyThemes(ready: Episode[], citations: WeeklyCitation[]): WeeklyTheme[] {
  const idxById = new Map(citations.map((c) => [c.episodeId, c.index]))
  const themes = topTopics(ready, 4)
  const out: WeeklyTheme[] = []
  for (const t of themes) {
    const points: string[] = []
    for (const e of ready) {
      const hay = `${e.title} ${e.summary?.synthesis?.join(' ') ?? ''} ${e.entities?.themes?.join(' ') ?? ''}`.toLowerCase()
      if (!hay.includes(t.label.toLowerCase())) continue
      const h = e.summary ? keyHighlights(e.summary)[0] : undefined
      if (!h) continue
      const n = idxById.get(e.id)
      points.push(`**${h.title.replace(/\*\*/g, '').trim()}**: ${h.detail.replace(/\*\*/g, '').trim()}${n ? ` [${n}]` : ''}`)
      if (points.length >= 4) break
    }
    if (points.length) out.push({ heading: t.label, points })
  }
  return out
}

/** Flatten the per-episode insights into the numbered `WeeklySource[]` the
 *  synthesis LLM consumes — shared by the client and the cron so the prompt (and
 *  thus the [n] alignment) is identical everywhere. */
export function buildWeeklySources(ready: Episode[], citations: WeeklyCitation[], podcastById: ById): WeeklySource[] {
  const idxById = new Map(citations.map((c) => [c.episodeId, c.index]))
  const parties = (list?: { name: string; why: string }[]): string | undefined =>
    list && list.length ? list.map((p) => `${p.name} — ${p.why}`).join('; ') : undefined
  return ready.map((e) => {
    const s = e.summary
    const quant = (s?.quantData ?? []).slice(0, 10).map((q) => `${q.metric}: ${q.value}${q.context ? ` (${q.context})` : ''}`).join('; ')
    const keyPoints = s ? keyHighlights(s).slice(0, 4).map((h) => h.title.replace(/\*\*/g, '').trim()).join('; ') : ''
    const diligence = (s?.insight?.diligenceQuestions ?? []).slice(0, 5).join('; ')
    return {
      index: idxById.get(e.id) ?? 0,
      show: podcastById(e.podcastId)?.title ?? 'Unknown show',
      title: e.title,
      date: new Date(e.publishedAt).toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' }),
      speaker: e.entities?.people?.[0] ?? '—',
      whatChanged: s?.insight?.whatChanged || undefined,
      whyItMatters: s?.insight?.whyItMatters || undefined,
      beneficiaries: parties(s?.insight?.beneficiaries),
      atRisk: parties(s?.insight?.atRisk),
      quant: quant || undefined,
      keyPoints: keyPoints || undefined,
      synthesis: (s?.synthesis?.[0] ?? '').replace(/\*\*/g, '').trim() || undefined,
      diligence: diligence || undefined,
    }
  })
}

// ── Deterministic builders (real data, no fabrication) ───────────────────────

// Group the week's episodes by show into per-show mini-digests — the weekly's
// primary structure. Everything here is lifted straight from the per-episode
// summaries (no AI re-abstraction), so specifics like a stock pitch survive intact.
export function buildShowDigests(ready: Episode[], podcastById: ById): WeeklyShowDigest[] {
  const byShow = new Map<string, Episode[]>()
  for (const e of ready) {
    const arr = byShow.get(e.podcastId) ?? []
    arr.push(e)
    byShow.set(e.podcastId, arr)
  }

  const built: { digest: WeeklyShowDigest; newest: number }[] = []
  for (const [podcastId, eps] of byShow) {
    // High-signal episodes lead, then newest-first within the show.
    const sorted = [...eps].sort(
      (a, b) =>
        (b.signal === 'high' ? 1 : 0) - (a.signal === 'high' ? 1 : 0) ||
        +new Date(b.publishedAt) - +new Date(a.publishedAt),
    )
    const show = podcastById(podcastId)?.title ?? 'Unknown show'

    const ideas: WeeklyIdea[] = sorted.flatMap((e) =>
      (e.summary?.ideas ?? []).map((idea) => ({ ...idea, episodeId: e.id })),
    )

    const takeaways: Takeaway[] = []
    for (const e of sorted) {
      for (const h of e.summary ? keyHighlights(e.summary) : []) {
        if (takeaways.length >= SHOW_TAKEAWAYS_CAP) break
        takeaways.push({ title: h.title.replace(/\*\*/g, '').trim(), detail: h.detail })
      }
    }

    const seenQ = new Set<string>()
    const questions: string[] = []
    for (const e of sorted) {
      for (const { q } of e.summary?.qa ?? []) {
        if (questions.length >= SHOW_QUESTIONS_CAP) break
        const norm = q.trim().toLowerCase()
        if (!norm || seenQ.has(norm)) continue
        seenQ.add(norm)
        questions.push(q.trim())
      }
    }

    built.push({
      digest: { show, podcastId, episodeIds: sorted.map((e) => e.id), episodeCount: sorted.length, ideas, takeaways, questions },
      newest: +new Date(sorted[0].publishedAt),
    })
  }

  // Shows that actually pitched ideas lead; then by episode count; then recency.
  return built
    .sort(
      (a, b) =>
        (b.digest.ideas.length ? 1 : 0) - (a.digest.ideas.length ? 1 : 0) ||
        b.digest.episodeCount - a.digest.episodeCount ||
        b.newest - a.newest,
    )
    .map((b) => b.digest)
}

export function derivedOverview(ready: Episode[], themes: { label: string }[], podcastById: ById): string[] {
  const shows = [...new Set(ready.map((e) => podcastById(e.podcastId)?.title).filter(Boolean) as string[])]
  const themeList = themes.slice(0, 4).map((t) => t.label)
  const lead = ready[0]
  const leadShow = podcastById(lead.podcastId)?.title
  const leadThesis = (lead.summary?.synthesis?.[0] ?? lead.blurb ?? '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim()

  const p1 =
    `This week, Munshot analysed ${ready.length} episode${ready.length === 1 ? '' : 's'} across ${shows.length} show${shows.length === 1 ? '' : 's'}` +
    (shows.length ? ` — ${listJoin(shows)}` : '') +
    '.' +
    (themeList.length ? ` The recurring topics were ${listJoin(themeList)}.` : '')
  const p2 = leadThesis ? `${leadShow ? `${leadShow} set the tone: ` : ''}${trim(leadThesis, 300)}` : ''
  return [p1, p2].filter(Boolean)
}

export function derivedTakeaways(ready: Episode[]): Takeaway[] {
  const sorted = [...ready].sort((a, b) => (b.signal === 'high' ? 1 : 0) - (a.signal === 'high' ? 1 : 0))
  const out: Takeaway[] = []
  for (const e of sorted) {
    const h = e.summary ? keyHighlights(e.summary)[0] : undefined
    if (h) out.push({ title: h.title, detail: h.detail })
    if (out.length >= 5) break
  }
  return out
}

export function aggregateMentions(ready: Episode[]): { people: string[]; companies: string[] } {
  const rank = (pick: (e: Episode) => string[]) => {
    const m = new Map<string, number>()
    ready.forEach((e) => pick(e).forEach((v) => {
      const k = v.trim()
      if (k) m.set(k, (m.get(k) ?? 0) + 1)
    }))
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k)
  }
  return {
    people: rank((e) => e.entities?.people ?? []).slice(0, 10),
    companies: rank((e) => e.entities?.companies ?? []).slice(0, 10),
  }
}

export function pickInteresting(ready: Episode[], podcastById: ById): WeeklySummary['interesting'] {
  const ep =
    ready.find((e) => e.signal === 'high' && e.summary?.highlights?.length) ??
    ready.find((e) => e.summary?.highlights?.length) ??
    ready[0]
  const h = ep.summary?.highlights?.[0]
  const pod = podcastById(ep.podcastId)
  // Surface the curated highlight — its headline plus the why-it-matters insight.
  // (Never the raw transcript segment: spoken lines are mid-sentence fragments
  // that read as nonsense out of context.)
  const title = (h?.title ?? ep.title).replace(/\*\*/g, '').trim()
  const insight = (h?.detail ?? ep.blurb ?? '').replace(/\*\*/g, '').trim()
  return {
    title: trim(title, 120),
    quote: trim(insight, 260),
    speaker: pod?.title ?? 'The hosts',
    role: ep.title,
    episodeId: ep.id,
  }
}

// ── small utilities ──────────────────────────────────────────────────────────
export function rangeLabel(ready: Episode[]): string {
  const times = ready.map((e) => +new Date(e.publishedAt)).sort((a, b) => a - b)
  const start = new Date(times[0])
  const end = new Date(times[times.length - 1])
  const short = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const full = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  return times[0] === times[times.length - 1] ? full(end) : `${short(start)} – ${full(end)}`
}

function listJoin(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

function trim(s: string, n: number): string {
  if (s.length <= n) return s
  const cut = s.lastIndexOf(' ', n)
  return `${s.slice(0, cut > 0 ? cut : n).trim()}…`
}

export function hashKey(ready: Episode[]): string {
  const sig = ready
    .map((e) => `${e.id}:${e.summary?.synthesis?.join('').length ?? 0}:${e.summary?.highlights?.length ?? 0}:${e.summary?.ideas?.length ?? 0}`)
    .join('|')
  let h = 5381
  for (let i = 0; i < sig.length; i++) h = ((h << 5) + h + sig.charCodeAt(i)) >>> 0
  return h.toString(36)
}
