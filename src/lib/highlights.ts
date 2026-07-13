import type { Highlight, Summary } from './types'

// The headline read of an episode: the highlights the AI flagged as key
// takeaways. Falls back to the full list when nothing is flagged (older
// summaries, or a model that skipped the flag) so no surface ever goes empty.
export function keyHighlights(s: Summary): Highlight[] {
  const key = s.highlights.filter((h) => h.key)
  return key.length ? key : s.highlights
}
