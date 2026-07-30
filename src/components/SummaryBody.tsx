import { RichText } from './RichText'
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
 *  instead of dumping raw dashes and asterisks. */
export function SummaryBody({ blocks, terms }: { blocks: string[]; terms: string[] }) {
  return (
    <div className="space-y-4">
      {blocks.map((block, i) => {
        const { header, isSection, paras, bullets } = parseSummaryBlock(block)
        const lead = i === 0
        return (
          <div key={i} className={isSection && i > 0 ? 'border-t border-outline-variant pt-4' : undefined}>
            {header &&
              (isSection ? (
                <h3 className="mb-2 text-[17px] font-semibold tracking-tight text-on-surface">{header}</h3>
              ) : (
                <h4 className="mb-1.5 mt-1 text-[15px] font-semibold text-on-surface">{header}</h4>
              ))}
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

/** A chat answer — the same light markdown (bold **headers**, "- " bullets,
 *  paragraphs) at a compact, uniform chat size. */
export function ChatAnswer({ text, terms }: { text: string; terms: string[] }) {
  const isBullet = (l: string) => /^([-*•]|\d+[.)])\s+/.test(l)
  const stripBullet = (l: string) => l.replace(/^([-*•]|\d+[.)])\s+/, '')
  const blocks = text
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)
  if (!blocks.length) return <p className="text-[14px] leading-relaxed text-on-surface">{text}</p>
  return (
    <div className="space-y-2.5 text-[14px] leading-relaxed text-on-surface">
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
            {header && <p className="mb-1 font-semibold text-on-surface">{header}</p>}
            {paras.map((p, j) => (
              <p key={`p${j}`} className={j ? 'mt-1.5' : ''}>
                <RichText text={p} terms={terms} />
              </p>
            ))}
            {bullets.length > 0 && (
              <ul className="mt-1 space-y-1">
                {bullets.map((b, j) => (
                  <li key={`b${j}`} className="flex gap-2">
                    <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-primary/60" />
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
