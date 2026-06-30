// ─────────────────────────────────────────────────────────────────────────────
// Sentiment engine — colors the "good" green and the "bad" red across the app.
//
// A deliberately small, domain-tuned lexicon (AI / tech / markets / finance) with
// negation handling, run entirely on the client. Zero network, zero latency,
// deterministic — identical results on live RSS and on mock data, and cheap
// enough to run on a full episode transcript at render time.
//
// Two outputs from one pass:
//   • findSentimentSpans(text) → the exact word/phrase spans to tint inline
//   • analyzeSentiment(text)   → a block's net lean, for the per-segment accent
//
// Design notes:
//   • Phrases are matched before single words ("cost center" beats "cost").
//   • A negator inside a short, clause-bounded window flips polarity, so
//     "not a moat" and "no longer scarce" read correctly (the hard part).
//   • The lexicon is intentionally specific and neutral text is left untouched —
//     the page should get a few anchors, never turn into a rainbow.
// ─────────────────────────────────────────────────────────────────────────────

export type Polarity = 'pos' | 'neg'

export interface SentimentSpan {
  /** Inclusive char offset into the source string. */
  start: number
  /** Exclusive char offset. */
  end: number
  /** Final polarity, after any negation flip. */
  polarity: Polarity
  /** 2 when an intensifier ("massively", "brutally") immediately precedes it. */
  intensity: 1 | 2
  /** True when a negator flipped the base term (drives the tooltip + debugging). */
  negated: boolean
}

export interface SentimentScore {
  /** Signed sum of intensities — positive weight minus negative weight. */
  score: number
  label: Polarity | 'neutral'
  posHits: number
  negHits: number
  /** Strong + clear enough to justify a block-level accent (gates the rainbow). */
  confident: boolean
}

// ── Lexicon ──────────────────────────────────────────────────────────────────
// Tuned for spoken AI / tech / markets / business analysis. High-PRECISION over
// recall: a term earns a slot only if it reads ONE way regardless of nearby
// context — so context-flippers ("premium", "strong", "cheap", "leading",
// "default", "trust", bare "win") are deliberately left out. Multi-word PHRASES
// win over their component words via longest-first ordering. Grow this freely;
// each addition just needs to be unambiguous in this domain.

const POSITIVE_PHRASES = [
  // moat / advantage
  'durable advantage', 'durable edge', 'competitive advantage', 'structural edge',
  'structurally underrated', 'pricing power', 'switching costs', 'network effect',
  'network effects', 'operating leverage', 'economies of scale', 'best-in-class',
  'market leader', 'wide moat', 'process leadership',
  // value / returns
  'value accrues', 'margin of safety', 'free cash flow', 'cash flow', 'all-time high',
  'record high',
]
const POSITIVE_WORDS = [
  // moat / edge
  'moat', 'moats', 'defensible', 'flywheel', 'advantage', 'advantages', 'edge', 'durable',
  'leadership', 'leader', 'leaders', 'dominant', 'dominance', 'kingmaker', 'juggernaut',
  'beachfront', 'keystone', 'masterstroke', 'scarce', 'scarcity',
  // winning / growth
  'winner', 'winners', 'winning', 'outperform', 'outperforms', 'outperformance',
  'outperformed', 'growth', 'grow', 'growing', 'grew', 'expand', 'expanding', 'expansion',
  'surge', 'surges', 'surging', 'surged', 'soar', 'soaring', 'soared', 'rally', 'rallied',
  'rallying', 'boom', 'booming', 'thrive', 'thriving', 'accelerate', 'accelerating',
  'accelerated', 'momentum', 'traction', 'breakthrough', 'breakthroughs', 'milestone',
  'milestones', 'rebound', 'recovery',
  // value / quality
  'accrue', 'accrues', 'accruing', 'accrued', 'compound', 'compounds', 'compounding',
  'alpha', 'upside', 'tailwind', 'tailwinds', 'profit', 'profits', 'profitable',
  'profitability', 'gain', 'gains', 'gained', 'accretive', 'undervalued', 'bullish',
  'opportunity', 'opportunities', 'efficient', 'efficiency', 'resilient', 'robust',
  'reliable', 'reliability', 'dependable', 'investable', 'adoption', 'unlock', 'unlocks',
  'unlocked', 'strengthen', 'strengthening',
]

const NEGATIVE_PHRASES = [
  // structural / strategic
  'cost center', 'binding constraint', 'concentration risk', 'systemic risk',
  'single-point-of-failure', 'agency problem', 'red flag', 'red flags', 'lead time',
  'lead times', 'sit dark', 'head-fake',
  // markets / capital
  'forced seller', 'forced sellers', 'forced to sell', 'circular financing',
  'margin compression', 'multiple compression', 'pricing pressure', 'price war',
  'race to the bottom', 'cash burn', 'value trap', 'going concern',
]
const NEGATIVE_WORDS = [
  // constraint / risk
  'risk', 'risks', 'risky', 'bottleneck', 'bottlenecks', 'constraint', 'constraints',
  'constrained', 'chokepoint', 'chokepoints', 'headwind', 'headwinds', 'threat', 'threats',
  'threaten', 'threatened', 'threatening', 'shortage', 'shortages', 'glut', 'oversupply',
  'overhang', 'fragile', 'stranded', 'shuttered',
  // decline / distress
  'decline', 'declines', 'declining', 'collapse', 'collapses', 'collapsing', 'crash',
  'crashes', 'plunge', 'plunges', 'plummet', 'plummeting', 'slump', 'slowdown', 'slowing',
  'downturn', 'recession', 'correction', 'drawdown', 'drawdowns', 'freefall', 'deteriorate',
  'deteriorating', 'stagnant', 'stagnation', 'struggle', 'struggles', 'struggling',
  'crisis', 'distress', 'distressed', 'doomed', 'loss', 'losses', 'losing',
  // valuation / capital
  'bubble', 'overvalued', 'expensive', 'compressing', 'compression', 'bearish', 'sell-off',
  'selloff', 'crowded', 'volatile', 'volatility', 'choppy', 'dilutive', 'dilution',
  'writedown', 'impairment', 'commoditize', 'commoditizes', 'commoditizing', 'commoditized',
  'commoditization', 'diworsification', 'downgrade', 'downgraded',
  // business / governance
  'weak', 'weakness', 'brutal', 'punishing', 'layoffs', 'layoff', 'lawsuit', 'lawsuits',
  'litigation', 'banned', 'banning', 'fraud', 'scandal', 'bankruptcy', 'bankrupt',
  'insolvent', 'problem', 'problems', 'problematic', 'trouble', 'troubled', 'troubling',
  'failure', 'failures', 'failed', 'concern', 'concerns', 'concerning', 'worry', 'worries',
  'worried', 'fear', 'fears', 'uncertainty', 'uncertain', 'caution', 'cautious',
  'skeptical', 'doubt', 'doubts', 'doubtful',
]

const TERM_POLARITY = new Map<string, Polarity>()
for (const t of [...POSITIVE_PHRASES, ...POSITIVE_WORDS]) TERM_POLARITY.set(t, 'pos')
for (const t of [...NEGATIVE_PHRASES, ...NEGATIVE_WORDS]) TERM_POLARITY.set(t, 'neg')

// A negator within NEG_WINDOW words (clause-bounded) flips the term it modifies.
const NEGATORS = new Set([
  'not', 'no', 'never', 'without', 'none', 'nobody', 'nothing', 'neither', 'nor',
  'cannot', 'lacks', 'lacking', 'fails', 'fail', 'avoid', 'avoids', 'avoiding',
  'hardly', 'barely', 'rarely', 'scarcely', 'unable',
  "n't", "don't", "doesn't", "didn't", "isn't", "aren't", "wasn't", "weren't",
  "won't", "can't", "couldn't", "wouldn't", "shouldn't", "hasn't", "haven't", "hadn't",
])
const INTENSIFIERS = new Set([
  'very', 'massively', 'hugely', 'extremely', 'deeply', 'severely', 'brutally',
  'incredibly', 'genuinely', 'wildly', 'enormously', 'increasingly',
  'significantly', 'substantially', 'dramatically', 'sharply', 'rapidly', 'vastly',
])

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// One precompiled matcher. Terms longest-first so the alternation prefers the
// longer hit ("cost center" over "cost"); each anchored with word boundaries so
// "risk" never fires inside "brisk".
const ALL_TERMS = [...TERM_POLARITY.keys()].sort((a, b) => b.length - a.length)
const LEX_RE = new RegExp(ALL_TERMS.map((t) => `\\b${escapeRe(t)}\\b`).join('|'), 'gi')

// Words + clause-boundary punctuation, with offsets, in one pass. Hyphens and
// apostrophes stay inside words ("sell-off", "don't"); standalone punctuation
// becomes a boundary that stops the negation scan.
const TOKEN_RE = /[A-Za-z][A-Za-z'’-]*|[.,;:!?—–]/g

interface LexToken {
  lower: string
  start: number
  word: boolean
  boundary: boolean
}

function lexTokens(text: string): LexToken[] {
  const toks: LexToken[] = []
  TOKEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TOKEN_RE.exec(text)) !== null) {
    const raw = m[0]
    const word = /[A-Za-z]/.test(raw[0])
    toks.push({
      lower: word ? raw.toLowerCase().replace(/’/g, "'") : raw,
      start: m.index,
      word,
      boundary: !word,
    })
  }
  return toks
}

const NEG_WINDOW = 5
const MAX_SPANS = 14 // safety cap against any pathological wall of color

function flip(p: Polarity): Polarity {
  return p === 'pos' ? 'neg' : 'pos'
}

/** The exact positive/negative spans in a string, for inline tinting. */
export function findSentimentSpans(text: string): SentimentSpan[] {
  const spans: SentimentSpan[] = []
  if (!text || text.length < 3) return spans

  const toks = lexTokens(text)
  const startToToken = new Map<number, number>()
  for (let i = 0; i < toks.length; i++) if (toks[i].word) startToToken.set(toks[i].start, i)

  LEX_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = LEX_RE.exec(text)) !== null) {
    const base = TERM_POLARITY.get(m[0].toLowerCase())
    if (m.index === LEX_RE.lastIndex) LEX_RE.lastIndex++ // zero-length guard
    if (!base) continue
    const start = m.index
    const end = start + m[0].length

    // Scan left for a negator / intensifier, stopping at the clause boundary.
    let negated = false
    let intensity: 1 | 2 = 1
    const ti = startToToken.get(start)
    if (ti !== undefined) {
      let scanned = 0
      for (let j = ti - 1; j >= 0; j--) {
        const t = toks[j]
        if (t.boundary) break
        if (!t.word) continue
        scanned++
        if (NEGATORS.has(t.lower)) negated = !negated
        if (INTENSIFIERS.has(t.lower)) intensity = 2
        if (scanned >= NEG_WINDOW) break
      }
    }

    spans.push({ start, end, polarity: negated ? flip(base) : base, intensity, negated })
    if (spans.length >= MAX_SPANS) break
  }

  return spans
}

/** A block's net polarity — drives the per-segment accent on the transcript. */
export function analyzeSentiment(text: string): SentimentScore {
  const spans = findSentimentSpans(text)
  let score = 0
  let posHits = 0
  let negHits = 0
  for (const s of spans) {
    if (s.polarity === 'pos') {
      score += s.intensity
      posHits++
    } else {
      score -= s.intensity
      negHits++
    }
  }
  const words = (text.match(/[A-Za-z]+/g) || []).length
  const label: Polarity | 'neutral' = score > 0 ? 'pos' : score < 0 ? 'neg' : 'neutral'
  const confident = Math.abs(score) >= 2 && words >= 6 && posHits + negHits >= 2
  return { score, label, posHits, negHits, confident }
}

/** Tailwind class(es) for an inline span — keeps styling in one place. */
export function sentimentClass(s: SentimentSpan): string {
  const base = s.polarity === 'pos' ? 'sentiment-pos' : 'sentiment-neg'
  return s.intensity === 2 ? `${base} sentiment-strong` : base
}

/** Hover tooltip for an inline span. */
export function sentimentTitle(s: SentimentSpan): string {
  const label = s.polarity === 'pos' ? 'Positive' : 'Negative'
  return s.negated ? `${label} · negated` : label
}
