import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useVideos } from '../store/Videos'
import { formatDuration, longDate } from '../lib/format'
import {
  encodeVideoId,
  isVideoPending,
  looksLikeYoutubeUrl,
  videoProcessingStatus,
  videoThumbnail,
  videoTitle,
  type VideoRecord,
} from '../lib/videos'
import { Icon } from '../components/Icon'
import { StatusBadge } from '../components/StatusBadge'

// Column template gains an Owner column in the admin (cross-account) view.
const GRID = 'grid-cols-[2.8fr_1.4fr_1fr_0.8fr_1.1fr]'
const GRID_ADMIN = 'grid-cols-[2.4fr_1.2fr_1.2fr_0.9fr_0.8fr_1.1fr]'

export default function Videos() {
  const { videos, admin, loading, loaded, error, addVideo, removeVideo, refresh } = useVideos()
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const grid = admin ? GRID_ADMIN : GRID

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return videos
    return videos.filter((v) =>
      [videoTitle(v), v.channel, v.owner, v.videoId].some((s) => (s || '').toLowerCase().includes(needle)),
    )
  }, [videos, q])

  const pendingCount = videos.filter(isVideoPending).length

  return (
    <div className="animate-fade-up">
      <div className="mb-md flex flex-wrap items-center justify-between gap-md">
        <div>
          <h2 className="text-display-lg text-on-background">Videos</h2>
          <p className="mt-1 text-metadata text-secondary">
            {videos.length} video{videos.length === 1 ? '' : 's'}
            {pendingCount > 0 && ` · ${pendingCount} transcribing`}
            {admin && ' · every account'}
          </p>
        </div>
        <button
          onClick={() => void refresh()}
          disabled={loading}
          className="press inline-flex items-center gap-2 rounded-lg border border-outline-variant bg-surface px-md py-2 text-metadata font-semibold text-on-surface hover:bg-surface-container-low disabled:opacity-50"
        >
          <Icon name="refresh" size={18} className={loading ? 'motion-safe:animate-spin' : ''} /> Refresh
        </button>
      </div>

      {!admin && <AddVideo onAdd={addVideo} />}

      {admin && (
        <div className="mb-md flex items-start gap-2 rounded-xl border border-outline-variant bg-surface-container-lowest px-md py-3 text-metadata text-secondary">
          <Icon name="admin_panel_settings" size={18} className="mt-0.5 shrink-0 text-primary" />
          <span>
            You're signed in as admin, so this lists every account's videos. Videos are added from a user's own
            account — each transcript belongs to whoever queued it.
          </span>
        </div>
      )}

      <div className="relative mb-md max-w-md">
        <Icon name="search" size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-outline" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search videos…"
          className="w-full rounded-lg border border-outline-variant bg-surface-container-lowest py-2.5 pl-11 pr-sm text-[14px] outline-none focus:border-primary"
        />
      </div>

      {error && (
        <div className="mb-md flex items-start gap-2 rounded-xl border border-error/30 bg-error-container/40 px-3 py-2.5 text-[13px] text-error">
          <Icon name="error" size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-outline-variant bg-surface-container-lowest shadow-card">
        <div className={`grid ${grid} items-center gap-md border-b border-outline-variant px-md py-3 text-label-caps uppercase text-outline`}>
          <span>Video</span>
          <span>Channel</span>
          {admin && <span>Owner</span>}
          <span className="flex items-center gap-1">Added <Icon name="arrow_downward" size={13} /></span>
          <span>Length</span>
          <span>Status</span>
        </div>

        {rows.map((video) => (
          <VideoRow
            key={encodeVideoId(video.owner, video.id)}
            video={video}
            grid={grid}
            showOwner={admin}
            onOpen={() => navigate(`/videos/${encodeVideoId(video.owner, video.id)}`)}
            onRemove={() => void removeVideo(video)}
          />
        ))}

        {rows.length === 0 && (
          <div className="flex flex-col items-center gap-1 px-md py-xl text-center">
            <Icon name={loaded ? 'smart_display' : 'progress_activity'} size={28} className={`text-outline ${loaded ? '' : 'motion-safe:animate-spin'}`} />
            <p className="text-body-md text-secondary">
              {!loaded
                ? 'Loading your videos…'
                : videos.length === 0
                ? admin
                  ? 'No account has added a video yet.'
                  : 'No videos yet — paste a YouTube link above to transcribe one.'
                : `Nothing matches “${q.trim()}”.`}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

/** The add box: paste a YouTube link, the backend transcribes it, and it lands
 *  in this account's list as "Queued" and updates itself as it progresses. */
function AddVideo({ onAdd }: { onAdd: (url: string) => Promise<VideoRecord> }) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  async function submit() {
    const value = url.trim()
    if (!value || busy) return
    if (!looksLikeYoutubeUrl(value)) {
      setError('That doesn’t look like a YouTube link.')
      setNote(null)
      return
    }
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const video = await onAdd(value)
      setUrl('')
      setNote(
        isVideoPending(video)
          ? 'Queued — transcription usually takes a few minutes. This list updates itself.'
          : 'Added — that video was already transcribed.',
      )
    } catch (err) {
      setError((err as Error)?.message || 'Could not queue that video.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mb-md rounded-2xl border border-outline-variant bg-surface-container-lowest p-md shadow-card">
      <div className="mb-2 flex items-center gap-2">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg chip-signal">
          <Icon name="smart_display" size={18} className="text-primary" fill />
        </span>
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold text-on-surface">Transcribe a YouTube video</h3>
          <p className="text-metadata text-secondary">The transcript, summary and chat land in your account only.</p>
        </div>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
        className="flex flex-col gap-2 sm:flex-row"
      >
        <input
          value={url}
          onChange={(e) => {
            setUrl(e.target.value)
            setError(null)
          }}
          placeholder="https://www.youtube.com/watch?v=…"
          className="flex-1 rounded-lg border border-outline-variant bg-surface px-3.5 py-2.5 text-[14px] outline-none focus:border-primary"
        />
        <button
          type="submit"
          disabled={!url.trim() || busy}
          className="press inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-metadata font-semibold text-on-primary hover:bg-primary-container disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Icon name={busy ? 'progress_activity' : 'add'} size={18} className={busy ? 'motion-safe:animate-spin' : ''} />
          {busy ? 'Queueing…' : 'Transcribe'}
        </button>
      </form>
      {error && (
        <p className="mt-2 flex items-center gap-1.5 text-[13px] text-error">
          <Icon name="error" size={15} /> {error}
        </p>
      )}
      {note && !error && (
        <p className="mt-2 flex items-center gap-1.5 text-[13px] text-secondary">
          <Icon name="check_circle" size={15} className="text-success" /> {note}
        </p>
      )}
    </div>
  )
}

function VideoRow({
  video,
  grid,
  showOwner,
  onOpen,
  onRemove,
}: {
  video: VideoRecord
  grid: string
  showOwner: boolean
  onOpen: () => void
  onRemove: () => void
}) {
  const title = videoTitle(video)
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
      className={`group grid w-full cursor-pointer ${grid} items-center gap-md border-b border-outline-variant px-md py-3.5 text-left transition-colors last:border-b-0 hover:bg-surface-container-low/60 focus:bg-surface-container-low/60 focus:outline-none`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <Thumb video={video} />
        <span className="min-w-0">
          <span className="block truncate text-body-md font-medium text-on-surface group-hover:text-primary">{title}</span>
          {video.status === 'failed' && video.error && (
            <span className="block truncate text-[12px] text-error">{video.error}</span>
          )}
        </span>
      </div>
      <span className="truncate text-metadata text-on-surface-variant">{video.channel || '—'}</span>
      {showOwner && <span className="truncate text-metadata text-on-surface-variant">{video.owner}</span>}
      <span className="text-metadata text-on-surface-variant">{longDate(new Date(video.createdAt).toISOString())}</span>
      <span className="text-metadata text-on-surface-variant">
        {video.durationSec > 0 ? formatDuration(video.durationSec) : '—'}
      </span>
      <span className="flex items-center justify-between gap-1">
        <StatusBadge status={videoProcessingStatus(video.status)} />
        <button
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          aria-label={`Remove ${title}`}
          title="Remove from your list"
          className="press grid h-8 w-8 shrink-0 place-items-center rounded-lg text-outline opacity-0 transition-opacity hover:bg-surface-container hover:text-error focus:opacity-100 group-hover:opacity-100"
        >
          <Icon name="delete" size={17} />
        </button>
      </span>
    </div>
  )
}

/** The YouTube thumbnail, with the colour tile as a fallback while it loads (or
 *  when the video id is unknown / the image is blocked). */
function Thumb({ video, className = 'h-11 w-[74px]' }: { video: VideoRecord; className?: string }) {
  const [failed, setFailed] = useState(false)
  const show = video.videoId && !failed
  return (
    <span className={`relative shrink-0 overflow-hidden rounded-lg bg-surface-container ${className}`}>
      {show ? (
        <img
          src={videoThumbnail(video.videoId)}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <span className="grid h-full w-full place-items-center text-outline">
          <Icon name="smart_display" size={20} />
        </span>
      )}
    </span>
  )
}
