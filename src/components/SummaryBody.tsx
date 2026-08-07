import { useMemo } from 'react'
import { RichText } from './RichText'
import { Icon } from './Icon'
import { CopyButton } from './CopyButton'
import { parseSummaryBlock } from '../lib/summaryFormat'

// ─────────────────────────────────────────────────────────────────────────────
// The two renderers for AI-written prose, shared by every surface that shows it
// (meeting detail, video detail): the full one-page summary and the compact
// chat answer. Both read the same light Markdown the Worker emits — a lead
// classification sentence, bold **section titles** and **sub-headers**, "- "
// bullets — so a meeting brief and a video brief render identically.
// ─────────────────────────────────────────────────────────────────────────────

/** The one-page summary body. Top-level sections render a notch larger with a
 *  divider so per-person / per-topic sub-headers nest visually beneath them —
 *  instead of dumping raw dashes and asterisks. Every section and sub-header
 *  gets its own copy button (raw Markdown, exactly as the Worker wrote it), plus
 *  one button up top for the whole summary — so a section, a sub-section, or the
 *  entire brief can be pasted elsewhere without reformatting. */
export function SummaryBody({ blocks, terms }: { blocks: string[]; terms: string[] }) {
  const parsed = useMemo(() => blocks.map(parseSummaryBlock), [blocks])

  // A top-level section's "copy" grabs its own block plus every sub-header block
  // that follows it, up to the next top-level section (or the end).
  function sectionMarkdown(i: number): string {
    let end = i + 1
    while (end < blocks.length && !parsed[end].isSection) end++
    return blocks.slice(i, end).join('\n\n')
  }

  return (
    <div className="space-y-4">
      {blocks.length > 0 && (
        <div className="flex justify-end">
          <CopyButton getText={() => blocks.join('\n\n')} label="Copy summary" title="Copy the full summary as Markdown" />
        </div>
      )}
      {blocks.map((block, i) => {
        const { header, isSection, paras, bullets } = parsed[i]
        const lead = i === 0
        return (
          <div key={i} className={isSection && i > 0 ? 'border-t border-outline-variant pt-4' : undefined}>
            {header && (
              <div className={`flex items-start justify-between gap-2 ${isSection ? 'mb-2' : 'mb-1.5 mt-1'}`}>
                {isSection ? (
                  <h3 className="text-[17px] font-semibold tracking-tight text-on-surface">{header}</h3>
                ) : (
                  <h4 className="text-[15px] font-semibold text-on-surface">{header}</h4>
                )}
                <CopyButton
                  getText={() => (isSection ? sectionMarkdown(i) : block)}
                  title={isSection ? `Copy "${header}" section as Markdown` : `Copy "${header}" as Markdown`}
                  size="sm"
                  className="mt-0.5"
                />
              </div>
            )}
            {paras.map((p, j) => (
              <p
                key={`p${j}`}
                className={
                  lead
                    ? 'text-body-lg leading-relaxed text-on-surface'
                    : 'text-body-md leading-relaxed text-on-surface-variant'
                }
              >
                <RichText text={p} terms={terms} />
              </p>
            ))}
            {bullets.length > 0 && (
              <ul className="mt-1.5 space-y-1.5">
                {bullets.map((b, j) => (
                  <li key={`b${j}`} className="flex gap-2.5 text-body-md leading-relaxed text-on-surface-variant">
                    <span className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-primary/50" />
                    <span className="min-w-0">
                      <RichText text={b} terms={terms} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )
}

// The [MM:SS] / [H:MM:SS] citations the assistant is asked to attach to every
// specific claim. Captured so the text can be split on them and each one turned
// into a jump back to the line it came from — an answer you can verify in one
// click rather than one you have to take on faith. Shared by the meeting and
// video chats, since both assistants are asked to cite the same way.
const CITATION = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g

function clockToSeconds(stamp: string): number | null {
  const parts = stamp.split(':')
  if (parts.length < 2 || parts.length > 3) return null
  const nums = parts.map((p) => Number(p))
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null
  return nums.reduce((acc, n) => acc * 60 + n, 0)
}

/** A line of an answer: entity/number/sentiment styling as everywhere else, with
 *  timestamp citations lifted out into clickable chips. */
function AnswerLine({ text, terms, onCite }: { text: string; terms: string[]; onCite?: (sec: number) => void }) {
  const parts = useMemo(() => {
    const out: { text: string; sec?: number }[] = []
    let last = 0
    for (const m of text.matchAll(CITATION)) {
      const sec = clockToSeconds(m[1])
      if (sec == null) continue
      if (m.index > last) out.push({ text: text.slice(last, m.index) })
      out.push({ text: m[1], sec })
      last = m.index + m[0].length
    }
    if (last < text.length) out.push({ text: text.slice(last) })
    return out
  }, [text])

  return (
    <>
      {parts.map((p, i) =>
        p.sec == null ? (
          <RichText key={i} text={p.text} terms={terms} />
        ) : onCite ? (
          <button
            key={i}
            onClick={() => onCite(p.sec!)}
            title="Open this moment in the transcript"
            className="press mx-0.5 inline-flex items-center gap-0.5 rounded-md border border-outline-variant bg-surface-container-low px-1.5 py-px align-baseline text-[12px] font-semibold tabular-nums text-primary hover:border-primary hover:bg-[#eff5ff]"
          >
            <Icon name="play_arrow" size={11} className="shrink-0" fill />
            {p.text}
          </button>
        ) : (
          <span key={i} className="font-semibold tabular-nums text-primary">
            {p.text}
          </span>
        ),
      )}
    </>
  )
}

/** A chat answer — the same light markdown (bold **headers**, "- " bullets,
 *  paragraphs) at a compact, uniform chat size. Each **headed** block gets its
 *  own copy button (raw Markdown for that block alone); a "Copy" button under
 *  the whole answer grabs it all. */
export function ChatAnswer({
  text,
  terms,
  onCite,
}: {
  text: string
  terms: string[]
  onCite?: (sec: number) => void
}) {
  const isBullet = (l: string) => /^([-*•]|\d+[.)])\s+/.test(l)
  const stripBullet = (l: string) => l.replace(/^([-*•]|\d+[.)])\s+/, '')
  const blocks = text
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)
  if (!blocks.length) return <p className="text-[14px] leading-relaxed text-on-surface">{text}</p>
  return (
    <div className="text-[14px] leading-relaxed text-on-surface">
      <div className="space-y-2.5">
        {blocks.map((block, i) => {
          const lines = block
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
          const headMatch = lines[0] ? /^\*\*(.+?)\*\*$/.exec(lines[0]) : null
          const header = headMatch ? headMatch[1] : null
          const rest = header ? lines.slice(1) : lines
          const bullets = rest.filter(isBullet).map(stripBullet)
          const paras = rest.filter((l) => !isBullet(l))
          return (
            <div key={i}>
              {header && (
                <div className="mb-1 flex items-start justify-between gap-2">
                  <p className="font-semibold text-on-surface">{header}</p>
                  <CopyButton getText={() => block} title={`Copy "${header}" as Markdown`} size="sm" />
                </div>
              )}
              {paras.map((p, j) => (
                <p key={`p${j}`} className={j ? 'mt-1.5' : ''}>
                  <AnswerLine text={p} terms={terms} onCite={onCite} />
                </p>
              ))}
              {bullets.length > 0 && (
                <ul className="mt-1 space-y-1">
                  {bullets.map((b, j) => (
                    <li key={`b${j}`} className="flex gap-2">
                      <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-primary/60" />
                      <span className="min-w-0">
                        <AnswerLine text={b} terms={terms} onCite={onCite} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )
        })}
      </div>
      <div className="mt-2 flex justify-end">
        <CopyButton getText={() => text} label="Copy" title="Copy this answer as Markdown" />
      </div>
    </div>
  )
}
