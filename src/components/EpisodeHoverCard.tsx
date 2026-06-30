import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FocusEvent as ReactFocusEvent, MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import type { Episode, ProcessingStatus } from '../lib/types'
import { useAppData } from '../store/AppData'
import { useSentiment } from '../store/Sentiment'
import { formatDuration, longDate } from '../lib/format'
import { episodeToneView } from '../lib/tone'
import { CoverTile } from './CoverTile'
import { Icon } from './Icon'
import { RichText, entityTerms } from './RichText'
import { StatusBadge } from './StatusBadge'
import { ToneMeter } from './ToneMeter'

// ─────────────────────────────────────────────────────────────────────────────
// Episode hover preview — a rich "toast" that appears when you hover (or focus) an
// episode row, so you can read the full picture and decide whether opening it is
// worth it. Opening a not-yet-processed episode kicks off transcription + the AI
// summary, so the card leads with status and exactly what a click will trigger.
//
// Rendered through a portal to <body> with position:fixed: the Episodes table is
// overflow-hidden and the page wrapper keeps a transform from its entrance
// animation (which would otherwise clip/anchor a fixed child), so escaping to the
// body is the only reliable way to float above everything.
// ─────────────────────────────────────────────────────────────────────────────

const OPEN_DELAY = 180 // ms before the card appears — avoids flicker when sweeping rows
const CLOSE_DELAY = 90 // ms grace after the pointer leaves
const GAP = 14 // px between the cursor and the card
const MARGIN = 12 // px minimum distance from any viewport edge
const CARD_W = 360 // px
const PREVIEW_ID = 'episode-hover-card'

// What a click actually does, per status — the decision the card exists to inform.
const ACTION_HINT: Record<ProcessingStatus, string> = {
  ready: 'Click to open the AI summary',
  detected: 'Not processed yet — click to transcribe & summarize',
  fetching: 'Fetching audio — click to follow progress',
  transcribing: 'Transcribing now — click to follow progress',
  summarizing: 'Summarizing now — click to follow progress',
  failed: 'Processing failed — click to retry',
}

type Point = { x: number; y: number }

interface Active {
  episode: Episode
  anchor: DOMRect
  point: Point | null // null when opened via keyboard focus (no cursor to anchor to)
}

export type EpisodeHoverProps = {
  onMouseEnter: (e: ReactMouseEvent<HTMLElement>) => void
  onMouseMove: (e: ReactMouseEvent<HTMLElement>) => void
  onMouseLeave: () => void
  onFocus: (e: ReactFocusEvent<HTMLElement>) => void
  onBlur: () => void
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  const cut = s.slice(0, n)
  const i = cut.lastIndexOf(' ')
  return (i > 40 ? cut.slice(0, i) : cut).trimEnd() + '…'
}

// Clamp the card inside the viewport, preferring the cursor's lower-right and
// flipping left when there isn't room.
function place(point: Point, size: { w: number; h: number }): { left: number; top: number } {
  const vw = window.innerWidth
  const vh = window.innerHeight
  let left = point.x + GAP
  if (left + size.w > vw - MARGIN) left = point.x - GAP - size.w
  left = Math.min(Math.max(left, MARGIN), Math.max(MARGIN, vw - MARGIN - size.w))
  let top = point.y - 24
  top = Math.min(Math.max(top, MARGIN), Math.max(MARGIN, vh - MARGIN - size.h))
  return { left, top }
}

// Hook the Episodes list uses: spread `hoverProps(ep)` on each row, render
// `preview` once, and read `activeId` to mark the previewed row.
export function useEpisodePreview() {
  const [active, setActive] = useState<Active | null>(null)
  const activeRef = useRef<Active | null>(null)
  const pending = useRef<{ episode: Episode; el: HTMLElement; point: Point | null } | null>(null)
  const openTimer = useRef<number | undefined>(undefined)
  const closeTimer = useRef<number | undefined>(undefined)

  const commit = useCallback((a: Active | null) => {
    activeRef.current = a
    setActive(a)
  }, [])

  const flush = useCallback(() => {
    const p = pending.current
    if (!p) return
    commit({ episode: p.episode, anchor: p.el.getBoundingClientRect(), point: p.point })
  }, [commit])

  const hardClose = useCallback(() => {
    window.clearTimeout(openTimer.current)
    window.clearTimeout(closeTimer.current)
    pending.current = null
    commit(null)
  }, [commit])

  const open = useCallback(
    (episode: Episode, el: HTMLElement, point: Point | null) => {
      window.clearTimeout(closeTimer.current)
      pending.current = { episode, el, point }
      window.clearTimeout(openTimer.current)
      if (activeRef.current) flush() // a card is already up → switch instantly, no delay
      else openTimer.current = window.setTimeout(flush, OPEN_DELAY)
    },
    [flush],
  )

  const close = useCallback(() => {
    window.clearTimeout(openTimer.current)
    closeTimer.current = window.setTimeout(() => commit(null), CLOSE_DELAY)
  }, [commit])

  // Dismiss on scroll / resize (the captured anchor goes stale) and on Escape.
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hardClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', hardClose, true)
    window.addEventListener('resize', hardClose)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', hardClose, true)
      window.removeEventListener('resize', hardClose)
    }
  }, [active, hardClose])

  // Clear any in-flight timers if the host unmounts mid-hover.
  useEffect(
    () => () => {
      window.clearTimeout(openTimer.current)
      window.clearTimeout(closeTimer.current)
    },
    [],
  )

  const hoverProps = useCallback(
    (episode: Episode): EpisodeHoverProps => ({
      onMouseEnter: (e) => open(episode, e.currentTarget, { x: e.clientX, y: e.clientY }),
      onMouseMove: (e) => {
        // Keep the anchor point fresh until the card actually opens.
        if (pending.current && !activeRef.current) pending.current.point = { x: e.clientX, y: e.clientY }
      },
      onMouseLeave: close,
      onFocus: (e) => open(episode, e.currentTarget, null),
      onBlur: close,
    }),
    [open, close],
  )

  const preview = active ? <EpisodeHoverCard {...active} /> : null
  return { hoverProps, preview, activeId: active?.episode.id ?? null, hardClose }
}

function EpisodeHoverCard({ episode, anchor, point }: Active) {
  const { podcastById } = useAppData()
  const { on: sentimentOn } = useSentiment()
  const podcast = podcastById(episode.podcastId)
  const tone = useMemo(() => episodeToneView(episode), [episode])
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  // Measure the rendered card and position it before paint (no flash at 0,0).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const from = point ?? { x: anchor.left + 24, y: anchor.bottom + 4 }
    setPos(place(from, { w: r.width, h: r.height }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episode.id, anchor.left, anchor.top, anchor.bottom, point?.x, point?.y])

  const s = episode.summary
  const terms = entityTerms(episode.entities)
  // Prefer the fuller show-notes when they say more than the row's teaser.
  const body = episode.notes && episode.notes.length > episode.blurb.length ? episode.notes : episode.blurb
  const themes = episode.entities.themes.slice(0, 4)
  const names = [...episode.entities.companies, ...episode.entities.people].slice(0, 5)

  // What source material exists to summarize from — the input for deciding whether
  // a not-yet-processed episode is worth triggering.
  const sources: { icon: string; label: string }[] = []
  if (episode.transcriptUrl) sources.push({ icon: 'description', label: 'Transcript' })
  if (episode.audioUrl) sources.push({ icon: 'graphic_eq', label: 'Audio' })
  if (!episode.transcriptUrl && episode.notes) sources.push({ icon: 'notes', label: 'Show notes' })

  return createPortal(
    <div
      ref={ref}
      id={PREVIEW_ID}
      role="tooltip"
      style={{
        position: 'fixed',
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        width: CARD_W,
        visibility: pos ? 'visible' : 'hidden',
      }}
      className="pop pointer-events-none z-[60] max-w-[calc(100vw-24px)] rounded-2xl border border-outline-variant bg-surface-container-lowest p-md shadow-card-hover"
    >
      {/* Provenance */}
      <div className="flex items-center gap-2.5">
        {podcast && <CoverTile podcast={podcast} className="h-9 w-9 shrink-0" showSource />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-metadata font-semibold text-on-surface">{podcast?.title ?? 'Podcast'}</p>
          {podcast?.author && <p className="truncate text-[12px] text-secondary">{podcast.author}</p>}
        </div>
        {episode.signal === 'high' && (
          <span className="shrink-0 rounded-full chip-signal px-2 py-0.5 text-label-caps uppercase">High signal</span>
        )}
      </div>

      {/* Full title — the row truncates it, so this is what hover is really for. */}
      <h3 className="mt-2.5 text-[15px] font-semibold leading-snug text-on-surface">{episode.title}</h3>

      {/* Meta */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-metadata text-secondary">
        <span className="inline-flex items-center gap-1">
          <Icon name="calendar_today" size={14} /> {longDate(episode.publishedAt)}
        </span>
        {episode.durationSec > 0 && (
          <span className="inline-flex items-center gap-1">
            <Icon name="schedule" size={14} /> {formatDuration(episode.durationSec)}
          </span>
        )}
        {s && sentimentOn && <ToneMeter tone={tone} />}
      </div>

      {/* Teaser / show-notes preview */}
      {body && (
        <p className="mt-2.5 text-[13px] leading-relaxed text-on-surface-variant">
          <RichText text={truncate(body, 300)} terms={terms} />
        </p>
      )}

      {/* Topics */}
      {themes.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {themes.map((t) => (
            <span key={t} className="rounded-full bg-surface-container px-2 py-0.5 text-[11px] font-medium text-on-surface-variant">
              {t}
            </span>
          ))}
        </div>
      )}

      {/* People & companies */}
      {names.length > 0 && (
        <p className="mt-2 flex items-center gap-1 text-[12px] text-secondary">
          <Icon name="group" size={13} className="shrink-0" />
          <span className="truncate">{names.join(' · ')}</span>
        </p>
      )}

      {/* What the summary already holds (processed episodes) */}
      {s && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-secondary">
          <span className="inline-flex items-center gap-1">
            <Icon name="star" size={13} /> {s.highlights.length} highlights
          </span>
          {s.qa.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <Icon name="help" size={13} /> {s.qa.length} Q&amp;A
            </span>
          )}
        </div>
      )}

      {/* What's available to process from (not-yet-summarized episodes) */}
      {!s && sources.length > 0 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <span className="text-[12px] text-secondary">Ready to process from</span>
          {sources.map((src) => (
            <span
              key={src.label}
              className="inline-flex items-center gap-1 rounded-md bg-surface-container px-2 py-0.5 text-[11px] font-medium text-on-surface-variant"
            >
              <Icon name={src.icon} size={13} /> {src.label}
            </span>
          ))}
        </div>
      )}

      {/* Status + the decision: exactly what clicking will do */}
      <div className="mt-3 flex items-center gap-2 border-t border-outline-variant pt-2.5">
        <StatusBadge status={episode.status} />
        <span className="text-[12px] font-medium text-on-surface-variant">{ACTION_HINT[episode.status]}</span>
      </div>
    </div>,
    document.body,
  )
}

export { PREVIEW_ID }
