import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { RichText } from './RichText'
import { Icon } from './Icon'
import { groupSummaryNodes, parseSummaryBlock } from '../lib/summaryFormat'

// ─────────────────────────────────────────────────────────────────────────────
// The two renderers for AI-written prose, shared by every surface that shows it
// (meeting detail, video detail): the full one-page summary and the compact
// chat answer. Both read the same light Markdown the Worker emits — a lead
// classification sentence, bold **section titles** and **sub-headers**, "- "
// bullets — so a meeting brief and a video brief render identically.
// ─────────────────────────────────────────────────────────────────────────────

/** The one-page summary body. Top-level sections render a notch larger with a
 *  divider so per-person / per-topic sub-headers nest visually beneath them —
 *  instead of dumping raw dashes and asterisks. */
export function SummaryBody({ blocks, terms }: { blocks: string[]; terms: string[] }) {
  return (
    <div className="space-y-4">
      {blocks.map((block, i) => {
        const { header, isSection, nodes } = parseSummaryBlock(block)
        const lead = i === 0
        return (
          <div key={i} className={isSection && i > 0 ? 'border-t border-outline-variant pt-4' : undefined}>
            {header &&
              (isSection ? (
                <h3 className="mb-2 text-[17px] font-semibold tracking-tight text-on-surface">{header}</h3>
              ) : (
                <h4 className="mb-1.5 mt-1 text-[15px] font-semibold text-on-surface">{header}</h4>
              ))}
            {groupSummaryNodes(nodes).map((group, j) =>
              group.kind === 'heading' ? (
                <h4 key={j} className="mb-1.5 mt-3 text-[15px] font-semibold text-on-surface">
                  {group.text}
                </h4>
              ) : group.kind === 'para' ? (
                <p
                  key={j}
                  className={
                    lead
                      ? 'text-body-lg leading-relaxed text-on-surface'
                      : 'text-body-md leading-relaxed text-on-surface-variant'
                  }
                >
                  <RichText text={group.text} terms={terms} />
                </p>
              ) : (
                <List key={j} ordered={group.ordered} className="mt-1.5 space-y-1.5">
                  {group.items.map((b, n) => (
                    <li key={n} className="flex gap-2.5 text-body-md leading-relaxed text-on-surface-variant">
                      <Marker ordered={group.ordered} index={n} className="mt-[9px] h-1.5 w-1.5 bg-primary/50" />
                      <span className="min-w-0">
                        <RichText text={b} terms={terms} />
                      </span>
                    </li>
                  ))}
                </List>
              ),
            )}
          </div>
        )
      })}
    </div>
  )
}

/** <ol> when the source was numbered, <ul> otherwise — so a ranked or sequenced
 *  list doesn't quietly become an unordered one. */
function List({
  ordered,
  className,
  children,
}: {
  ordered: boolean
  className?: string
  children: ReactNode
}) {
  return ordered ? <ol className={className}>{children}</ol> : <ul className={className}>{children}</ul>
}

/** The dot, or the original number when the list was numbered. */
function Marker({ ordered, index, className }: { ordered: boolean; index: number; className?: string }) {
  if (!ordered) return <span className={`shrink-0 rounded-full ${className ?? ''}`} />
  return (
    <span className="mt-px shrink-0 text-[13px] font-semibold tabular-nums text-primary/70">{index + 1}.</span>
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

/** A chat answer — the same light markdown as the summaries (**bold** or "## "
 *  headers, "- " and "1." lists, paragraphs) at a compact, uniform chat size.
 *  Parsed by the shared parseSummaryBlock rather than a private copy, so the
 *  chat can't fall behind on syntax the summary already handles. */
export function ChatAnswer({
  text,
  terms = [],
  onCite,
}: {
  text: string
  terms?: string[]
  onCite?: (sec: number) => void
}) {
  const blocks = text
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)
  if (!blocks.length) return <p className="text-[14px] leading-relaxed text-on-surface">{text}</p>
  return (
    <div className="space-y-2.5 text-[14px] leading-relaxed text-on-surface">
      {blocks.map((block, i) => {
        const { header, nodes } = parseSummaryBlock(block)
        return (
          <div key={i}>
            {header && <p className="mb-1 font-semibold text-on-surface">{header}</p>}
            {groupSummaryNodes(nodes).map((group, j) =>
              group.kind === 'heading' ? (
                <p key={j} className={`font-semibold text-on-surface ${j ? 'mb-1 mt-2.5' : 'mb-1'}`}>
                  {group.text}
                </p>
              ) : group.kind === 'para' ? (
                <p key={j} className={j ? 'mt-1.5' : ''}>
                  <AnswerLine text={group.text} terms={terms} onCite={onCite} />
                </p>
              ) : (
                <List key={j} ordered={group.ordered} className="mt-1 space-y-1">
                  {group.items.map((b, n) => (
                    <li key={n} className="flex gap-2">
                      <Marker ordered={group.ordered} index={n} className="mt-[9px] h-1 w-1 bg-primary/60" />
                      <span className="min-w-0">
                        <AnswerLine text={b} terms={terms} onCite={onCite} />
                      </span>
                    </li>
                  ))}
                </List>
              ),
            )}
          </div>
        )
      })}
    </div>
  )
}
