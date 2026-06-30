import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { useSentiment } from '../store/Sentiment'
import { findSentimentSpans, sentimentClass, sentimentTitle } from '../lib/sentiment'

// ─────────────────────────────────────────────────────────────────────────────
// RichText — automatic emphasis for a text-heavy dashboard.
//
// Reduces "see → process → understand" time by giving the eye anchors. Four
// purposeful tiers, applied to plain (often machine-generated) strings:
//
//   1. **key clause**  → heaviest, near-black   (the gist, if you read nothing else)
//   2. metrics/numbers → semibold BLUE          ($1.7T, 90%, 10x, 2,000-day, 2027)
//   3. named entities  → gentle weight bump      (companies / people you pass in)
//   4. sentiment       → soft GREEN / RED tint   (the "good" and the "bad" language)
//
// Numbers are detected conservatively (must carry a %, $, ×, comma, decimal, or
// be a 19xx/20xx year) so bare counts like "3 questions" stay calm. Sentiment is
// applied ONLY to the plain runs left between the structural tokens above, so a
// number stays blue and an entity stays weighted — the tiers never nest. The
// green/red layer is gated on the global sentiment toggle.
// ─────────────────────────────────────────────────────────────────────────────

const NUMBER = [
  String.raw`\$\d[\d,]*(?:\.\d+)?(?:[KMBT]|bn|bps)?`, //   $1.7T  $50M  $5bn
  String.raw`\d[\d,]*(?:\.\d+)?%`, //                       90%  1.5%
  String.raw`\d+(?:\.\d+)?x\b`, //                          10x  1.5x
  String.raw`\d{1,3}(?:,\d{3})+(?:-[A-Za-z]+)?`, //         2,000  2,000-day
  String.raw`\d+\.\d+`, //                                  3.14
  String.raw`\b(?:19|20)\d{2}s?\b`, //                      2027  1990s
].join('|')

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Drop any leftover markdown asterisks (the model sometimes emits an unbalanced
// ** ) so they can never render as literal characters in the UI.
function stripStars(s: string): string {
  return s.replace(/\*+/g, '')
}

export function RichText({ text, terms = [] }: { text: string; terms?: string[] }) {
  const { on } = useSentiment()
  const nodes = useMemo(() => tokenize(text, terms, on), [text, terms.join(''), on])
  return <>{nodes}</>
}

// Mutable key counter threaded through the plain-run splitter so every emitted
// element gets a stable, unique key.
type KeyRef = { n: number }

// Split a plain run into green/red sentiment spans + untouched text. Only ever
// called on the gaps BETWEEN structural tokens, so sentiment never nests inside a
// number / entity / bold token. Stray markdown asterisks are stripped from every
// plain run first (the model sometimes emits an unbalanced ** ), so they can never
// render literally regardless of the toggle. When sentiment is off it still strips,
// just pushes the cleaned string with no green/red layer.
function pushPlain(out: ReactNode[], slice: string, sentimentOn: boolean, k: KeyRef): void {
  const cleaned = stripStars(slice)
  if (!cleaned) return
  if (!sentimentOn) {
    out.push(cleaned)
    return
  }
  const spans = findSentimentSpans(cleaned)
  if (!spans.length) {
    out.push(cleaned)
    return
  }
  let last = 0
  for (const s of spans) {
    if (s.start > last) out.push(cleaned.slice(last, s.start))
    out.push(
      <span key={k.n++} className={sentimentClass(s)} title={sentimentTitle(s)}>
        {cleaned.slice(s.start, s.end)}
      </span>,
    )
    last = s.end
  }
  if (last < cleaned.length) out.push(cleaned.slice(last))
}

function tokenize(text: string, terms: string[], sentimentOn: boolean): ReactNode[] {
  // Longer entities first so "Invest Like the Best" wins over "Best".
  const cleaned = [...new Set(terms)]
    .map((t) => t.trim())
    .filter((t) => t.length >= 4)
    .sort((a, b) => b.length - a.length)
  const termAlt = cleaned.length ? `|\\b(?:${cleaned.map(escapeRe).join('|')})\\b` : ''

  let re: RegExp
  try {
    re = new RegExp(`(\\*\\*[^*]+\\*\\*)|(${NUMBER})${termAlt}`, 'g')
  } catch {
    // Never let a bad entity string break rendering — still strip stars + apply sentiment.
    const out: ReactNode[] = []
    pushPlain(out, text, sentimentOn, { n: 0 })
    return out
  }

  const out: ReactNode[] = []
  let last = 0
  const k: KeyRef = { n: 0 }
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) pushPlain(out, text.slice(last, m.index), sentimentOn, k)
    const tok = m[0]
    if (m[1]) {
      out.push(
        <strong key={k.n++} className="font-semibold text-on-surface">
          {tok.slice(2, -2)}
        </strong>,
      )
    } else if (m[2]) {
      out.push(
        <span key={k.n++} className="font-semibold tabular-nums text-primary">
          {tok}
        </span>,
      )
    } else {
      out.push(
        <span key={k.n++} className="font-medium text-on-surface">
          {tok}
        </span>,
      )
    }
    last = m.index + tok.length
    if (m.index === re.lastIndex) re.lastIndex++ // guard against any zero-length match
  }
  if (last < text.length) pushPlain(out, text.slice(last), sentimentOn, k)
  return out
}

/** Convenience: the entity terms worth highlighting in a body of text. */
export function entityTerms(entities?: { people: string[]; companies: string[] }): string[] {
  if (!entities) return []
  return [...entities.companies, ...entities.people]
}
