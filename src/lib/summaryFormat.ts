// ─────────────────────────────────────────────────────────────────────────────
// Summary format — the one place that understands the light Markdown the meeting
// summary is written in, so every surface (the in-app SummaryBody, the PDF, the
// Word doc, and the HTML email) renders the same structure identically.
//
// The Worker emits a summary as blank-line-separated blocks. A block is one of:
//
//   • lead prose      — the opening classification sentence (no header)
//   • a SECTION        — a lone **Section Title** (e.g. "Discussion by Person")
//   • a titled block   — a header then prose paragraphs and/or "- " bullets,
//                        where the header is either a top-level section
//                        ("Meeting Summary") or a sub-header (a person's name,
//                        "For Neha:", "General Team Requirement")
//
// A header is written EITHER as a lone **Bold** line or as an ATX "## Heading".
// The model emits both — it is writing Markdown, not our house dialect — and a
// parser that knew only the bold form left the hashes on screen as literal text
// ("## Dashboard Features Demonstrated"), because nothing downstream strips a
// character the parser never claimed.
//
// Bullets may open with a bold thematic label — "- **Data Correction:** …" — which
// we split out so renderers can weight the label without re-parsing Markdown.
//
// `nodes` keeps paragraphs, bullets and mid-block headings in the order they
// were written. The older `paras`/`bullets` arrays are still exposed for the
// export renderers, but they are two filtered passes over one block, so reading
// them re-orders the content: every bullet lands after every paragraph, however
// the author interleaved them. Prefer `nodes` (or `groupSummaryNodes`).
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
  // A video brief's sections (same light Markdown, different anatomy — see
  // generateVideoSummary in worker/index.js).
  'Video Summary',
  'Key Topics',
  'Key Takeaways',
])

export interface SummaryBullet {
  /** The short bold label a bullet opens with ("Data Correction"), sans colon. */
  label?: string
  /** The remaining bullet text (still carries any other inline **bold**). */
  text: string
}

/** One line of a block, in the order it was written. */
export type SummaryNode =
  | { kind: 'para'; text: string }
  | { kind: 'heading'; text: string; level: number | null }
  /** `ordered` is true for "1." / "1)" markers, so a numbered list doesn't
   *  render as anonymous dots and lose its sequence. */
  | { kind: 'bullet'; text: string; ordered: boolean }

/** Consecutive bullets folded into one list, ready to render. */
export type SummaryGroup =
  | { kind: 'para'; text: string }
  | { kind: 'heading'; text: string; level: number | null }
  | { kind: 'list'; ordered: boolean; items: string[] }

export interface ParsedSummaryBlock {
  /** The block's leading header — a lone **Bold** line or an ATX "## Heading" —
   *  with the markers removed, if it has one. */
  header: string | null
  /** Hash count for an ATX header ("## X" → 2); null for a **Bold** header. */
  headerLevel: number | null
  /** True when `header` is a top-level section (vs a person / owner sub-header). */
  isSection: boolean
  /** Everything after the header, in document order. */
  nodes: SummaryNode[]
  /** Non-bullet lines (after any header). Kept for the export renderers; see the
   *  ordering caveat in the header comment — new code should read `nodes`. */
  paras: string[]
  /** Bullet lines with the list marker stripped — inline **bold** (incl. any
   *  leading "**Label:**") is left intact, so inline renderers bold it for free.
   *  Call {@link splitBulletLabel} when a renderer wants the label pulled out. */
  bullets: string[]
}

const BULLET_RE = /^([-*•]|\d+[.)])\s+/
// "## Title", with the optional closing hashes ATX allows ("## Title ##"). The
// space is required, so "#1 priority" stays prose.
const ATX_RE = /^(#{1,6})\s+(.+?)\s*#*$/
const BOLD_LINE_RE = /^\*\*(.+?)\*\*$/
const isBulletLine = (l: string) => BULLET_RE.test(l)
const stripBulletMarker = (l: string) => l.replace(BULLET_RE, '')

/** A header line in either accepted spelling, or null. The returned text is
 *  marker-free: renderers print it as-is, so a "## **Title**" that kept its
 *  asterisks would show them literally. */
function readHeadingLine(line: string): { text: string; level: number | null } | null {
  const atx = ATX_RE.exec(line)
  if (atx) {
    const text = atx[2].trim().replace(BOLD_LINE_RE, '$1').trim()
    return text ? { text, level: atx[1].length } : null
  }
  const bold = BOLD_LINE_RE.exec(line)
  if (bold) {
    const text = bold[1].trim()
    return text ? { text, level: null } : null
  }
  return null
}

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

  // A bullet is checked first: "- ## not a heading" is a bullet whose text
  // happens to start with hashes, not a heading.
  const head = lines[0] && !isBulletLine(lines[0]) ? readHeadingLine(lines[0]) : null
  const rest = head ? lines.slice(1) : lines

  const nodes: SummaryNode[] = rest.map((line): SummaryNode => {
    const marker = BULLET_RE.exec(line)
    if (marker) {
      return { kind: 'bullet', text: stripBulletMarker(line), ordered: /\d/.test(marker[1]) }
    }
    const heading = readHeadingLine(line)
    return heading ? { kind: 'heading', ...heading } : { kind: 'para', text: line }
  })

  const header = head ? head.text : null
  return {
    header,
    headerLevel: head ? head.level : null,
    isSection: header != null && SUMMARY_SECTION_TITLES.has(header),
    nodes,
    // A mid-block heading lands in `paras` for the export renderers — as its
    // text, never as raw "## text".
    paras: nodes.filter((n) => n.kind !== 'bullet').map((n) => n.text),
    bullets: nodes.filter((n) => n.kind === 'bullet').map((n) => n.text),
  }
}

/** Fold consecutive bullets of the same kind into one list, leaving paragraphs
 *  and headings where they were. What a renderer actually wants to walk. */
export function groupSummaryNodes(nodes: SummaryNode[]): SummaryGroup[] {
  const out: SummaryGroup[] = []
  for (const node of nodes) {
    if (node.kind !== 'bullet') {
      out.push(node)
      continue
    }
    const last = out[out.length - 1]
    if (last && last.kind === 'list' && last.ordered === node.ordered) last.items.push(node.text)
    else out.push({ kind: 'list', ordered: node.ordered, items: [node.text] })
  }
  return out
}

/** Split a full summary (raw markdown or already-split blocks) into parsed blocks. */
export function parseSummary(synthesis: string | string[]): ParsedSummaryBlock[] {
  const blocks = Array.isArray(synthesis)
    ? synthesis
    : synthesis.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean)
  return blocks.map(parseSummaryBlock)
}
