// ─────────────────────────────────────────────────────────────────────────────
// Summary format — the one place that understands the light Markdown the meeting
// summary is written in, so every surface (the in-app SummaryBody, the PDF, the
// Word doc, and the HTML email) renders the same structure identically.
//
// The Worker emits a summary as blank-line-separated blocks. A block is one of:
//
//   • lead prose      — the opening classification sentence (no header)
//   • a SECTION        — a lone **Section Title** (e.g. "Discussion by Person")
//   • a titled block   — **Header** then prose paragraphs and/or "- " bullets,
//                        where the header is either a top-level section
//                        ("Meeting Summary") or a sub-header (a person's name,
//                        "For Neha:", "General Team Requirement")
//
// Bullets may open with a bold thematic label — "- **Data Correction:** …" — which
// we split out so renderers can weight the label without re-parsing Markdown.
// ─────────────────────────────────────────────────────────────────────────────

/** The top-level section titles — rendered a notch larger / with a rule, so the
 *  per-person and per-owner sub-headers nest visually beneath them. Older
 *  summaries used "Decisions & Action Items" / "Detailed Discussion"; keep those
 *  so already-cached briefs still read with the right hierarchy. */
export const SUMMARY_SECTION_TITLES: ReadonlySet<string> = new Set([
  'Meeting Summary',
  'Discussion by Person',
  'Actionable To-Dos',
  'Decisions & Action Items',
  'Detailed Discussion',
])

export interface SummaryBullet {
  /** The short bold label a bullet opens with ("Data Correction"), sans colon. */
  label?: string
  /** The remaining bullet text (still carries any other inline **bold**). */
  text: string
}

export interface ParsedSummaryBlock {
  /** The block's leading **Bold** header, if it has one. */
  header: string | null
  /** True when `header` is a top-level section (vs a person / owner sub-header). */
  isSection: boolean
  /** Prose paragraph lines that aren't bullets (after any header). */
  paras: string[]
  /** Bullet lines with the list marker stripped — inline **bold** (incl. any
   *  leading "**Label:**") is left intact, so inline renderers bold it for free.
   *  Call {@link splitBulletLabel} when a renderer wants the label pulled out. */
  bullets: string[]
}

const BULLET_RE = /^([-*•]|\d+[.)])\s+/
const isBulletLine = (l: string) => BULLET_RE.test(l)
const stripBulletMarker = (l: string) => l.replace(BULLET_RE, '')

/** Pull a leading "**Label:**" (or "**Label** —") off a bullet into {label, text}. */
export function splitBulletLabel(line: string): SummaryBullet {
  const m = /^\*\*(.+?)\*\*\s*[:—\-]?\s*/.exec(line)
  if (!m) return { text: line }
  const label = m[1].replace(/[:\s]+$/, '').trim()
  const text = line.slice(m[0].length).trim()
  // Only treat it as a label when there's a real body after it — otherwise the
  // whole bullet is just an emphasised sentence, keep it as text.
  if (!label || !text) return { text: line }
  return { label, text }
}

/** Parse one blank-line-delimited summary block into its structural pieces. */
export function parseSummaryBlock(block: string): ParsedSummaryBlock {
  const lines = block
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const headMatch = lines[0] ? /^\*\*(.+?)\*\*$/.exec(lines[0]) : null
  const header = headMatch ? headMatch[1].trim() : null
  const rest = header ? lines.slice(1) : lines
  const bullets = rest.filter(isBulletLine).map(stripBulletMarker)
  const paras = rest.filter((l) => !isBulletLine(l))
  return {
    header,
    isSection: header != null && SUMMARY_SECTION_TITLES.has(header),
    paras,
    bullets,
  }
}

/** Split a full summary (raw markdown or already-split blocks) into parsed blocks. */
export function parseSummary(synthesis: string | string[]): ParsedSummaryBlock[] {
  const blocks = Array.isArray(synthesis)
    ? synthesis
    : synthesis.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean)
  return blocks.map(parseSummaryBlock)
}
