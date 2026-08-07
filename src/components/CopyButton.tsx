import { useState } from 'react'
import { Icon } from './Icon'

// ─────────────────────────────────────────────────────────────────────────────
// A copy-to-clipboard button shared by every surface that shows AI-written
// Markdown (the meeting/video summary, chat answers). `getText` is called lazily
// on click so callers can hand over a raw Markdown slice (a whole summary, one
// section, one sub-header block) without recomputing it on every render.
// ─────────────────────────────────────────────────────────────────────────────
export function CopyButton({
  getText,
  label,
  title,
  size = 'md',
  className = '',
}: {
  getText: () => string
  /** Renders a labelled pill instead of an icon-only ghost button. */
  label?: string
  title?: string
  size?: 'sm' | 'md'
  className?: string
}) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(getText())
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      /* clipboard blocked — nothing to report */
    }
  }

  if (label) {
    return (
      <button
        type="button"
        onClick={copy}
        title={title}
        className={`press inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-outline-variant bg-surface px-2.5 py-1.5 text-[12.5px] font-semibold text-on-surface hover:bg-surface-container-low ${className}`}
      >
        <Icon name={copied ? 'check' : 'content_copy'} size={14} className={copied ? 'text-success' : ''} />
        {copied ? 'Copied' : label}
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? 'Copied' : title}
      aria-label={copied ? 'Copied' : (title ?? 'Copy')}
      className={`press grid ${size === 'sm' ? 'h-6 w-6' : 'h-7 w-7'} shrink-0 place-items-center rounded-md text-secondary hover:bg-surface-container hover:text-primary ${className}`}
    >
      <Icon name={copied ? 'check' : 'content_copy'} size={size === 'sm' ? 13 : 15} className={copied ? 'text-success' : ''} />
    </button>
  )
}
