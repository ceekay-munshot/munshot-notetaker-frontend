// ─────────────────────────────────────────────────────────────────────────────
// Tone — rolls the per-word sentiment up into one decision-useful read for a
// whole episode (or the week). The inline coloring shows you *where*; this shows
// you the net *lean*, with the underlying counts so it's never a black box.
//
// Aggregation is per-text (paragraph / highlight / answer), summed — not one giant
// concatenation — so the inline span cap in `findSentimentSpans` can never
// undercount a long body, and the score reflects every signal.
// ─────────────────────────────────────────────────────────────────────────────

import type { Episode, EpisodeTone, ToneAspect, WeeklySummary } from './types'
import { analyzeSentiment } from './sentiment'

export type ToneLabel = 'positive' | 'cautious' | 'mixed' | 'neutral'

export interface Tone {
  label: ToneLabel
  /** Net signed weight across all analysed text (positive minus negative). */
  score: number
  posHits: number
  negHits: number
  /** Share of the signal that is positive, 0..1 — drives the proportion bar. */
  posRatio: number
  /** Total sentiment hits (pos + neg): how much there is to read at all. */
  signal: number
}

const NEUTRAL: Tone = { label: 'neutral', score: 0, posHits: 0, negHits: 0, posRatio: 0.5, signal: 0 }

function combine(texts: string[]): Tone {
  let score = 0
  let posHits = 0
  let negHits = 0
  for (const t of texts) {
    if (!t) continue
    const s = analyzeSentiment(t)
    score += s.score
    posHits += s.posHits
    negHits += s.negHits
  }
  const signal = posHits + negHits
  if (signal < 2) return NEUTRAL // one stray hit isn't a tone
  let label: ToneLabel
  if (score >= 2) label = 'positive'
  else if (score <= -2) label = 'cautious'
  else label = 'mixed' // real signal on both sides, no clear net lean
  return { label, score, posHits, negHits, posRatio: posHits / signal, signal }
}

/** An episode's tone, drawn from its *analysis* (not the raw transcript). */
export function episodeTone(ep: Episode): Tone {
  const s = ep.summary
  if (!s) return NEUTRAL
  return combine([
    ...s.synthesis,
    ...s.highlights.flatMap((h) => [h.title, h.detail]),
    ...s.qa.map((q) => q.a),
  ])
}

/** The week's net tone, synthesised across the weekly summary's prose. */
export function weeklyTone(w: WeeklySummary): Tone {
  return combine([
    ...w.overview,
    ...w.takeaways.flatMap((t) => [t.title, t.detail]),
    ...w.contradictions,
    ...w.questions,
  ])
}

// ─────────────────────────────────────────────────────────────────────────────
// Tone *view* — one shape the gauge renders from, sourced from the LLM tone when
// present and falling back to the lexicon roll-up above otherwise. This is where
// the gauge's source switches from keyword counts to the context-aware LLM read;
// the inline word tints (RichText / sentiment.ts) are untouched.
// ─────────────────────────────────────────────────────────────────────────────

export interface ToneView {
  /** Drives the icon + colour (shared META in ToneMeter). */
  label: ToneLabel
  /** Green share of the proportion bar, 0..1. */
  posRatio: number
  /** Whether there's enough directional signal to draw the bar. */
  bar: boolean
  /** One-sentence net-read explanation — LLM tone only. */
  rationale?: string
  /** Per-subject reads — LLM tone only. */
  aspects?: ToneAspect[]
}

/** Runtime guard: the tone may come from an older localStorage cache, a hand-edited
 *  mock fixture, or a partial payload — never trust the static type alone. */
export function isEpisodeTone(t: unknown): t is EpisodeTone {
  if (!t || typeof t !== 'object') return false
  const v = t as { overall?: unknown; rationale?: unknown; aspects?: unknown }
  return (
    typeof v.overall === 'string' &&
    (['positive', 'cautious', 'mixed', 'neutral'] as const).includes(v.overall as ToneLabel) &&
    typeof v.rationale === 'string' &&
    Array.isArray(v.aspects)
  )
}

function fromLexicon(t: Tone): ToneView {
  return { label: t.label, posRatio: t.posRatio, bar: t.signal >= 2 }
}

// Bar is driven by the DIRECTIONAL aspect mix only — neutral aspects never enter the
// denominator, so the green/red split reflects expressed positive vs negative.
function fromLLM(t: EpisodeTone): ToneView {
  const pos = t.aspects.filter((a) => a.sentiment === 'positive').length
  const neg = t.aspects.filter((a) => a.sentiment === 'negative').length
  const decided = pos + neg
  return {
    label: t.overall, // label is always the LLM's net read, independent of the bar
    posRatio: decided ? pos / decided : 0.5,
    bar: decided >= 1,
    rationale: t.rationale,
    aspects: t.aspects,
  }
}

/** An episode's tone for the gauge — LLM read when present, else the lexicon roll-up. */
export function episodeToneView(ep: Episode): ToneView {
  const t = ep.summary?.tone
  return isEpisodeTone(t) ? fromLLM(t) : fromLexicon(episodeTone(ep))
}

/** The week's tone for the gauge. Prefers aggregating the per-episode LLM tones, but
 *  only once they cover at least half the week's episodes — otherwise one freshly
 *  re-summarised episode would speak for a week of stale ones. Falls back to the
 *  lexicon roll-up of the weekly prose. */
export function weeklyToneView(w: WeeklySummary, episodeById: (id: string) => Episode | undefined): ToneView {
  const tones = w.sourceEpisodeIds.map((id) => episodeById(id)?.summary?.tone).filter(isEpisodeTone)
  const coverage = tones.length / Math.max(1, w.sourceEpisodeIds.length)
  if (tones.length && coverage >= 0.5) {
    const aspects = tones.flatMap((t) => t.aspects)
    const pos = aspects.filter((a) => a.sentiment === 'positive').length
    const neg = aspects.filter((a) => a.sentiment === 'negative').length
    const decided = pos + neg
    let label: ToneLabel
    if (!decided) label = 'neutral'
    else if (pos > neg * 1.5) label = 'positive'
    else if (neg > pos * 1.5) label = 'cautious'
    else label = 'mixed'
    return { label, posRatio: decided ? pos / decided : 0.5, bar: decided >= 1 }
  }
  return fromLexicon(weeklyTone(w))
}
