import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Episode, Podcast } from '../lib/types'
import { resolveVideo } from '../lib/api'
import { episodeSourceUrl, sourceLabel, youtubeVideoId } from '../lib/source'
import { Icon } from './Icon'

interface SourceLinkProps {
  episode: Episode
  podcast?: Podcast
  /** 'button' = labelled pill (headers); 'icon' = compact brand glyph (list rows). */
  variant?: 'button' | 'icon'
  className?: string
}

// Branded "Listen on Apple Podcasts" / "Watch on YouTube" entry point. YouTube
// shows ALWAYS play in the in-app modal (YouTube's /embed/ endpoint is built
// for iframes): navigating to youtube.com breaks when the app itself runs
// inside an embedded/sandboxed context — popups inherit the sandbox and the
// tab dies with ERR_BLOCKED_BY_RESPONSE. Episodes with a direct video link
// play immediately; RSS-fed ones (e.g. All-In) resolve their id on open via
// /api/resolve-video. Apple links keep the plain new-tab anchor.
export function SourceLink({ episode, podcast, variant = 'button', className = '' }: SourceLinkProps) {
  const href = episodeSourceUrl(episode, podcast)
  const label = sourceLabel(podcast)
  const youtube = podcast?.source === 'youtube'
  const videoId = youtube ? youtubeVideoId(episode) : null
  const [open, setOpen] = useState(false)

  const player = youtube && open && (
    <WatchModal
      videoId={videoId}
      resolveQuery={`${podcast?.title ?? ''} ${episode.title}`.trim()}
      title={episode.title}
      href={href}
      onClose={() => setOpen(false)}
    />
  )

  if (variant === 'icon') {
    return (
      <>
        {youtube ? (
          <button
            onClick={(e) => {
              e.stopPropagation()
              setOpen(true)
            }}
            title={label}
            aria-label={label}
            aria-haspopup="dialog"
            className={`press grid h-8 w-8 shrink-0 place-items-center rounded-lg hover:bg-surface-container ${className}`}
          >
            <SourceMark youtube={youtube} size={18} />
          </button>
        ) : (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            title={label}
            aria-label={label}
            className={`press grid h-8 w-8 shrink-0 place-items-center rounded-lg hover:bg-surface-container ${className}`}
          >
            <SourceMark youtube={youtube} size={18} />
          </a>
        )}
        {player}
      </>
    )
  }

  const pillClass = `press group inline-flex items-center gap-2 rounded-lg border border-outline-variant bg-surface py-2 pl-2 pr-3.5 text-metadata font-semibold text-on-surface hover:border-primary/40 hover:bg-surface-container-low ${className}`
  return (
    <>
      {youtube ? (
        <button
          onClick={(e) => {
            e.stopPropagation()
            setOpen(true)
          }}
          aria-haspopup="dialog"
          className={pillClass}
        >
          <SourceMark youtube={youtube} size={22} />
          {label}
        </button>
      ) : (
        <a href={href} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className={pillClass}>
          <SourceMark youtube={youtube} size={22} />
          {label}
        </a>
      )}
      {player}
    </>
  )
}

// In-app player — centered modal (modals keep transform-origin center), .pop
// entrance, Esc / scrim / ✕ to close. The privacy-enhanced embed host avoids
// dropping tracking cookies until playback starts. Opens instantly: with no
// direct video id it shows a resolving state while /api/resolve-video finds
// the episode, then swaps the player in; an unresolvable episode degrades to
// an external search link.
function WatchModal({
  videoId: directId,
  resolveQuery,
  title,
  href,
  onClose,
}: {
  videoId: string | null
  resolveQuery: string
  title: string
  href: string
  onClose: () => void
}) {
  const [videoId, setVideoId] = useState(directId)
  const [failed, setFailed] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (videoId) return
    const ctrl = new AbortController()
    resolveVideo(resolveQuery, ctrl.signal)
      .then((id) => {
        if (ctrl.signal.aborted) return
        if (id) setVideoId(id)
        else setFailed(true)
      })
      .catch(() => {
        /* aborted (modal closed) — nothing to update */
      })
    return () => ctrl.abort()
  }, [videoId, resolveQuery])

  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null
    panelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
      restoreRef.current?.focus?.()
    }
  }, [onClose])

  // Portaled to <body>: ancestors with persistent transforms (entrance
  // animations, .lift rows) would otherwise become the containing block for
  // position:fixed and trap the dialog inside themselves.
  return createPortal(
    <div className="fixed inset-0 z-[80] grid place-items-center p-4" role="dialog" aria-modal="true" aria-label={`Playing: ${title}`}>
      <button aria-hidden tabIndex={-1} onClick={onClose} className="fade-in absolute inset-0 cursor-default bg-inverse-surface/60" />
      <div
        ref={panelRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="pop relative w-[min(94vw,960px)] overflow-hidden rounded-2xl border border-outline-variant bg-surface shadow-card-hover focus:outline-none"
      >
        <div className="flex items-center gap-sm border-b border-outline-variant py-2.5 pl-md pr-2.5">
          <p className="min-w-0 flex-1 truncate text-[14px] font-semibold text-on-surface">{title}</p>
          <a
            href={videoId ? `https://www.youtube.com/watch?v=${videoId}` : href}
            target="_blank"
            rel="noreferrer"
            className="press hidden shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-metadata font-semibold text-secondary hover:bg-surface-container-low hover:text-on-surface sm:inline-flex"
          >
            Open on YouTube <Icon name="open_in_new" size={15} />
          </a>
          <button
            onClick={onClose}
            aria-label="Close player"
            className="press grid h-8 w-8 shrink-0 place-items-center rounded-lg text-secondary hover:bg-surface-container-low hover:text-on-surface"
          >
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="aspect-video w-full bg-black" aria-busy={!videoId && !failed}>
          {videoId ? (
            <iframe
              src={`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0`}
              title={title}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              className="h-full w-full"
            />
          ) : failed ? (
            <div className="grid h-full w-full place-items-center p-md">
              <div className="pop flex flex-col items-center gap-1.5 text-center">
                <p className="text-[14px] font-semibold text-white/90">Couldn't find this episode on YouTube</p>
                <p className="text-metadata text-white/60">It may not be published there yet.</p>
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  className="press mt-2 inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-2 text-metadata font-semibold text-white hover:bg-white/15"
                >
                  Search on YouTube <Icon name="open_in_new" size={15} />
                </a>
              </div>
            </div>
          ) : (
            <div className="grid h-full w-full place-items-center">
              <div className="animate-pulse flex flex-col items-center gap-2.5">
                <SourceMark youtube size={34} />
                <p className="text-metadata font-medium text-white/70">Finding this episode on YouTube…</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

// Recognisable platform mark: Apple Podcasts (purple gradient + mic) or
// YouTube (red rounded-rect + play). Drawn as SVG so it stays crisp at any size.
function SourceMark({ youtube, size }: { youtube: boolean; size: number }) {
  if (youtube) {
    return (
      <span
        className="grid shrink-0 place-items-center rounded-[5px]"
        style={{ width: size, height: size, background: '#FF0000' }}
      >
        <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" fill="#fff" aria-hidden="true">
          <path d="M8 5v14l11-7z" />
        </svg>
      </span>
    )
  }
  return (
    <span
      className="grid shrink-0 place-items-center rounded-[6px]"
      style={{ width: size, height: size, background: 'linear-gradient(150deg, #E96CFF 0%, #C961DE 40%, #7C2FB8 100%)' }}
    >
      {/* Apple-Podcasts-style microphone: a dot + three broadcast arcs. */}
      <svg width={size * 0.62} height={size * 0.62} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="8.6" r="2.1" fill="#fff" />
        <path
          d="M12 13.2c-2.2 0-4 1.5-4 3.4 0 1.2 1.8 2 4 2s4-.8 4-2c0-1.9-1.8-3.4-4-3.4Z"
          fill="#fff"
        />
        <path
          d="M6.2 6.1a8 8 0 0 1 11.6 0M8.2 8.2a5.1 5.1 0 0 1 7.6 0"
          stroke="#fff"
          strokeWidth="1.5"
          strokeLinecap="round"
          opacity="0.85"
        />
      </svg>
    </span>
  )
}
