import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAppData } from '../store/AppData'
import { useDateRange } from '../store/DateRange'
import { useChannelFilter } from '../store/ChannelFilter'
import { useSentiment } from '../store/Sentiment'
import { formatDuration, longDate } from '../lib/format'
import { episodeToneView } from '../lib/tone'
import type { Episode } from '../lib/types'
import { CoverTile } from '../components/CoverTile'
import { Icon } from '../components/Icon'
import { SourceLink } from '../components/SourceLink'
import { StatusBadge } from '../components/StatusBadge'
import { ToneBadge } from '../components/ToneMeter'
import { PREVIEW_ID, useEpisodePreview } from '../components/EpisodeHoverCard'
import type { EpisodeHoverProps } from '../components/EpisodeHoverCard'

// Column template flexes by one when the Tone column is shown (sentiment on).
const GRID = 'grid-cols-[2.6fr_1.6fr_1fr_0.8fr_1fr]'
const GRID_TONE = 'grid-cols-[2.4fr_1.5fr_0.9fr_0.8fr_0.9fr_1fr]'

export default function Episodes() {
  const { episodes, podcastById } = useAppData()
  const { preset, presets, setPreset, inRange, rangeLabel } = useDateRange()
  const { inChannel } = useChannelFilter()
  const { on: sentimentOn } = useSentiment()
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const grid = sentimentOn ? GRID_TONE : GRID
  // Hover/focus preview "toast" so a row's full picture is visible before you
  // click in (which, for un-processed episodes, triggers the AI pipeline).
  const { hoverProps, preview, activeId, hardClose } = useEpisodePreview()

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return episodes
      .filter((e) => inChannel(e.podcastId))
      .filter((e) => inRange(e.publishedAt))
      .filter((e) => {
        if (!needle) return true
        return e.title.toLowerCase().includes(needle) || podcastById(e.podcastId)?.title.toLowerCase().includes(needle)
      })
      .sort((a, b) => +new Date(b.publishedAt) - +new Date(a.publishedAt))
  }, [episodes, inChannel, inRange, q, podcastById])

  return (
    <div className="animate-fade-up">
      <div className="mb-md flex flex-wrap items-center justify-between gap-md">
        <div>
          <h2 className="text-display-lg text-on-background">Episodes</h2>
          <p className="mt-1 text-metadata text-secondary">
            {rows.length} episode{rows.length === 1 ? '' : 's'} · {preset.days === null ? 'all time' : rangeLabel}
          </p>
        </div>
        <Link
          to="/discover"
          className="press inline-flex items-center gap-2 rounded-lg border border-outline-variant bg-surface px-md py-2 text-metadata font-semibold text-on-surface hover:bg-surface-container-low"
        >
          <Icon name="add" size={18} /> Add source
        </Link>
      </div>

      <div className="relative mb-md max-w-md">
        <Icon name="search" size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-outline" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search episodes…"
          className="w-full rounded-lg border border-outline-variant bg-surface-container-lowest py-2.5 pl-11 pr-sm text-[14px] outline-none focus:border-primary"
        />
      </div>

      {/* Date filter chips — synced with the top-bar date range */}
      <div className="mb-md flex flex-wrap gap-2">
        {presets.map((p) => (
          <button
            key={p.id}
            onClick={() => setPreset(p.id)}
            className={`press rounded-lg px-4 py-1.5 text-[13px] font-medium ${
              preset.id === p.id
                ? 'bg-primary-fixed/60 text-primary ring-1 ring-primary/20'
                : 'border border-outline-variant bg-surface text-secondary hover:bg-surface-container-low'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-2xl border border-outline-variant bg-surface-container-lowest shadow-card">
        <div className={`grid ${grid} items-center gap-md border-b border-outline-variant px-md py-3 text-label-caps uppercase text-outline`}>
          <span>Episode</span>
          <span>Podcast</span>
          <span className="flex items-center gap-1">Date <Icon name="arrow_downward" size={13} /></span>
          <span>Duration</span>
          {sentimentOn && <span>Tone</span>}
          <span>Status</span>
        </div>

        {rows.map((ep) => (
          <EpisodeRow
            key={ep.id}
            episode={ep}
            grid={grid}
            showTone={sentimentOn}
            hover={hoverProps(ep)}
            active={activeId === ep.id}
            onOpen={() => {
              hardClose()
              navigate(`/episodes/${ep.id}`)
            }}
          />
        ))}

        {rows.length === 0 && (
          <div className="flex flex-col items-center gap-1 px-md py-xl text-center">
            <Icon name="event_busy" size={28} className="text-outline" />
            <p className="text-body-md text-secondary">No episodes in {preset.days === null ? 'your library' : rangeLabel}.</p>
            {preset.days !== null && (
              <button onClick={() => setPreset('all')} className="text-metadata font-semibold text-primary hover:underline">
                Show all time
              </button>
            )}
          </div>
        )}
      </div>

      {preview}
    </div>
  )
}

function EpisodeRow({
  episode,
  grid,
  showTone,
  hover,
  active,
  onOpen,
}: {
  episode: Episode
  grid: string
  showTone: boolean
  hover: EpisodeHoverProps
  active: boolean
  onOpen: () => void
}) {
  const { podcastById } = useAppData()
  const podcast = podcastById(episode.podcastId)
  const tone = useMemo(() => episodeToneView(episode), [episode])
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
      {...hover}
      aria-describedby={active ? PREVIEW_ID : undefined}
      className={`group grid w-full cursor-pointer ${grid} items-center gap-md border-b border-outline-variant px-md py-3.5 text-left transition-colors last:border-b-0 hover:bg-surface-container-low/60 focus:bg-surface-container-low/60 focus:outline-none ${
        active ? 'bg-surface-container-low/60 ring-1 ring-inset ring-primary/15' : ''
      }`}
    >
      <div className="flex min-w-0 items-center gap-3">
        {podcast && <CoverTile podcast={podcast} className="h-11 w-11 shrink-0" />}
        <span className="truncate text-body-md font-medium text-on-surface group-hover:text-primary">{episode.title}</span>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        {podcast && <CoverTile podcast={podcast} className="h-6 w-6 shrink-0" rounded="rounded" />}
        <span className="truncate text-metadata text-on-surface-variant">{podcast?.title}</span>
      </div>
      <span className="text-metadata text-on-surface-variant">{longDate(episode.publishedAt)}</span>
      <span className="text-metadata text-on-surface-variant">{formatDuration(episode.durationSec)}</span>
      {showTone && (
        <span className="min-w-0 truncate text-metadata">
          <ToneBadge tone={tone} />
        </span>
      )}
      <span className="flex items-center justify-between gap-1">
        <StatusBadge status={episode.status} />
        <SourceLink episode={episode} podcast={podcast} variant="icon" />
      </span>
    </div>
  )
}
