import { useState } from 'react'
import type { Podcast } from '../lib/types'
import { Icon } from './Icon'

// Cover art: the podcast's real square artwork when available, falling back to a
// generated tonal gradient + monogram (so something on-brand still renders if an
// image is missing or fails to load). The brand color sits behind the image, so
// transparent logos read cleanly. Scales crisply at any tile size.

interface CoverTileProps {
  podcast: Pick<Podcast, 'color' | 'monogram' | 'source' | 'artworkUrl'>
  className?: string
  rounded?: string
  /** Show the source glyph (podcast / youtube) in the corner. */
  showSource?: boolean
}

export function CoverTile({
  podcast,
  className = 'w-12 h-12',
  rounded = 'rounded-lg',
  showSource = false,
}: CoverTileProps) {
  const [imgFailed, setImgFailed] = useState(false)
  const useArt = !!podcast.artworkUrl && !imgFailed
  const fontSize = podcast.monogram.length >= 3 ? 32 : 44

  return (
    <div
      className={`relative grid place-items-center overflow-hidden ${rounded} ${className}`}
      style={{ background: `linear-gradient(145deg, ${podcast.color} 0%, ${shade(podcast.color, -16)} 100%)` }}
    >
      {useArt ? (
        <img
          src={podcast.artworkUrl}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setImgFailed(true)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <>
          <div
            className="absolute inset-0 opacity-25"
            style={{ background: 'radial-gradient(120% 80% at 20% 0%, rgba(255,255,255,0.3), transparent 60%)' }}
          />
          <svg viewBox="0 0 100 100" className="relative h-full w-full" role="img" aria-label={podcast.monogram}>
            <text
              x="50"
              y="52"
              textAnchor="middle"
              dominantBaseline="central"
              fill="#ffffff"
              fontFamily="Inter, system-ui, sans-serif"
              fontWeight="700"
              fontSize={fontSize}
              letterSpacing="-1"
            >
              {podcast.monogram}
            </text>
          </svg>
        </>
      )}
      {showSource && (
        <span className="absolute bottom-1.5 right-1.5 grid h-5 w-5 place-items-center rounded-full bg-black/30 backdrop-blur">
          <Icon name={podcast.source === 'youtube' ? 'smart_display' : 'podcasts'} size={13} className="text-white" />
        </span>
      )}
    </div>
  )
}

// Darken/lighten a hex color by a percentage (-100..100).
function shade(hex: string, percent: number): string {
  const n = parseInt(hex.replace('#', ''), 16)
  const t = percent < 0 ? 0 : 255
  const p = Math.abs(percent) / 100
  const r = (n >> 16) & 0xff
  const g = (n >> 8) & 0xff
  const b = n & 0xff
  const mix = (c: number) => Math.round((t - c) * p) + c
  return `#${((1 << 24) + (mix(r) << 16) + (mix(g) << 8) + mix(b)).toString(16).slice(1)}`
}
