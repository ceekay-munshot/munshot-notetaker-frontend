// ─────────────────────────────────────────────────────────────────────────────
// YouTube video ⇄ UI-model mapping.
//
// The second transcript source alongside meetings. The Worker fetches a video's
// captions from YouTube itself and stores them in D1, so the UI can show it with
// the same transcript / summary / chat surface a meeting gets. This module maps
// a VideoRecord onto the existing Episode + Podcast shapes, and turns stored
// segments (or, as a fallback, raw transcript text) into the TranscriptSegment
// list those components already render.
// ─────────────────────────────────────────────────────────────────────────────

import type { Episode, Podcast, ProcessingStatus, TranscriptSegment } from './types'

/** Where a video is in the backend's transcription pipeline. */
export type VideoStatus = 'queued' | 'processing' | 'completed' | 'failed'

/** A video as the Worker stores and returns it (GET /api/youtube). */
export interface VideoRecord {
  /** The transcript id — the D1 primary key, as a string. */
  id: string
  /** The account that added it (and owns the transcript). */
  owner: string
  url: string
  /** The 11-character YouTube id, when known. */
  videoId: string
  title: string
  channel: string
  durationSec: number
  status: VideoStatus
  error?: string
  createdAt: number
  updatedAt: number
  hasTranscript?: boolean
}

/** One stored transcript line, exactly as the Worker holds it in D1 — already
 *  timed, so the UI never has to infer timings from text. `speaker` is null on
 *  the captions path (YouTube gives no diarization). */
export interface StoredSegment {
  index: number
  start: number
  end: number
  text: string
  speaker: string | null
  language: string | null
}

/** Stored segments → the shape the transcript view renders. */
export function segmentsFromStored(stored: StoredSegment[]): TranscriptSegment[] {
  return stored.map((s, i) => ({
    id: String(s.index ?? i),
    speaker: s.speaker || 'Transcript',
    role: 'guest',
    timestamp: stampFor(s.start),
    text: s.text,
  }))
}

/** True while the backend is still working on it — the UI polls in this state. */
export function isVideoPending(v: { status: VideoStatus }): boolean {
  return v.status === 'queued' || v.status === 'processing'
}

/** Video status → the pipeline status the shared badges/panels render. */
export function videoProcessingStatus(status: VideoStatus): ProcessingStatus {
  switch (status) {
    case 'completed':
      return 'ready'
    case 'failed':
      return 'failed'
    case 'processing':
      return 'transcribing'
    default:
      return 'detected'
  }
}

/** The display name: whatever the backend knows, else the video id, else the job. */
export function videoTitle(v: VideoRecord): string {
  return v.title?.trim() || (v.videoId ? `Video ${v.videoId}` : `Video ${v.id}`)
}

/** YouTube's own thumbnail for a video id (no API key needed). */
export function videoThumbnail(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
}

/** The canonical watch URL — the stored one, else rebuilt from the video id. */
export function videoWatchUrl(v: VideoRecord): string {
  if (v.url) return v.url
  return v.videoId ? `https://www.youtube.com/watch?v=${v.videoId}` : ''
}

/** Client-side check so an obviously wrong link is caught before a round trip.
 *  The Worker re-validates (it is the authority) — this only sharpens the form. */
export function looksLikeYoutubeUrl(input: string): boolean {
  const raw = input.trim()
  if (!raw) return false
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return true
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
    const host = u.hostname.replace(/^www\./i, '').toLowerCase()
    return host === 'youtu.be' || host.endsWith('youtube.com') || host === 'youtube-nocookie.com'
  } catch {
    return false
  }
}

// ── Transcript parsing ────────────────────────────────────────────────────────
// The backend's .txt transcript has no guaranteed shape, so every common one is
// handled: "[mm:ss] line", "mm:ss line", SRT/VTT cue blocks, and plain prose.

const BRACKET_STAMP = /^\[(\d{1,2}:\d{2}(?::\d{2})?)(?:\.\d+)?\]\s*/
const BARE_STAMP = /^(\d{1,2}:\d{2}(?::\d{2})?)(?:[.,]\d+)?\s*[-–—)\]]?\s+/
const CUE_RANGE = /^(\d{1,2}:\d{2}(?::\d{2})?)(?:[.,]\d+)?\s*-->\s*\d{1,2}:\d{2}/

/** "1:02:03" / "12:34" → seconds. Returns null when it isn't a clock. */
export function parseStamp(stamp: string): number | null {
  const parts = stamp.split(':').map((p) => Number(p))
  if (parts.some((n) => !Number.isFinite(n))) return null
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return null
}

/** Seconds → "MM:SS" / "H:MM:SS", matching the meeting transcript's clock. */
export function stampFor(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`
}

interface RawLine {
  seconds: number | null
  text: string
}

// One pass over the transcript body: strips WEBVTT/SRT scaffolding (cue numbers,
// "-->" ranges) and pulls a leading timestamp off a line when it carries one.
function rawLines(text: string): RawLine[] {
  const out: RawLine[] = []
  let pendingStamp: number | null = null
  const lines = text.split(/\r?\n/).map((l) => l.trim())
  // The next non-empty line — an SRT cue number is only a cue number when a cue
  // range follows it.
  const nextMeaningful = (from: number): string => {
    for (let i = from; i < lines.length; i++) if (lines[i]) return lines[i]
    return ''
  }
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]
    if (!trimmed || /^WEBVTT/i.test(trimmed)) continue
    const cue = CUE_RANGE.exec(trimmed)
    if (cue) {
      pendingStamp = parseStamp(cue[1]) // the next text line belongs to this cue
      continue
    }
    // An SRT cue number — but only in that structural position. A caption whose
    // whole text is a number ("2026") is real content, not scaffolding.
    if (/^\d+$/.test(trimmed) && trimmed.length <= 5 && CUE_RANGE.test(nextMeaningful(i + 1))) continue
    let body = trimmed
    let seconds: number | null = pendingStamp
    pendingStamp = null
    const bracket = BRACKET_STAMP.exec(body)
    if (bracket) {
      seconds = parseStamp(bracket[1]) ?? seconds
      body = body.slice(bracket[0].length)
    } else {
      const bare = BARE_STAMP.exec(body)
      if (bare) {
        seconds = parseStamp(bare[1]) ?? seconds
        body = body.slice(bare[0].length)
      }
    }
    body = body.trim()
    if (!body) continue
    // A transcript with no line breaks at all (one long paragraph, which the
    // .txt route often is) would otherwise become a single unreadable segment —
    // break an over-long line into sentences so it can be paragraphed below.
    if (body.length > BLOCK_CHARS) {
      const sentences = body.match(/[^.!?]+[.!?]+["')\]]?\s*|[^.!?]+$/g) || [body]
      sentences.forEach((s, i) => {
        const text = s.trim()
        if (text) out.push({ seconds: i === 0 ? seconds : null, text })
      })
      continue
    }
    out.push({ seconds, text: body })
  }
  return out
}

// Caption lines are often 3–8 words each, which reads terribly as one row per
// line — merge consecutive lines into paragraph-sized blocks (keeping the first
// line's timestamp) so the transcript scans like the meeting one.
const BLOCK_CHARS = 320

/** Parse a raw transcript into the segment list the transcript view renders. */
export function parseVideoTranscript(text: string): TranscriptSegment[] {
  const lines = rawLines(String(text || ''))
  if (!lines.length) return []

  const segments: TranscriptSegment[] = []
  let buffer = ''
  let start: number | null = null

  const flush = () => {
    const body = buffer.trim()
    if (!body) return
    segments.push({
      id: String(segments.length),
      speaker: 'Transcript',
      role: 'guest',
      timestamp: start == null ? '—' : stampFor(start),
      text: body,
    })
    buffer = ''
    start = null
  }

  for (const line of lines) {
    if (!buffer) start = line.seconds
    buffer = buffer ? `${buffer} ${line.text}` : line.text
    // Break on length, or at a sentence end once the block is substantial.
    if (buffer.length >= BLOCK_CHARS || (buffer.length > BLOCK_CHARS / 2 && /[.!?]["')\]]?$/.test(line.text))) flush()
  }
  flush()
  return segments
}

/** The video's length in seconds: what the backend reported, else the last
 *  timestamp in the transcript (so the header still shows a real duration). */
export function videoDuration(v: VideoRecord, segments: TranscriptSegment[]): number {
  if (v.durationSec > 0) return v.durationSec
  for (let i = segments.length - 1; i >= 0; i--) {
    const sec = parseStamp(segments[i].timestamp)
    if (sec != null) return sec
  }
  return 0
}

// ── Episode/Podcast projection ────────────────────────────────────────────────
// Everything downstream of a summary (the renderers, the PDF, the Word export)
// speaks Episode + Podcast, so a video is projected onto those shapes exactly
// the way a meeting is in lib/meetings.ts.

const SEP = '~~'

/** Round-trippable handle for a video: its owner + job id, like a meeting's. */
export function encodeVideoId(owner: string, id: string): string {
  return `${owner}${SEP}${id}`
}

export function decodeVideoId(handle: string): { owner: string; id: string } {
  const i = handle.indexOf(SEP)
  if (i === -1) return { owner: '', id: handle }
  return { owner: handle.slice(0, i), id: handle.slice(i + SEP.length) }
}

// Deterministic cover colour from the video id — the same trick the meeting
// covers use, so a video with no thumbnail still gets a stable identity.
function colorFor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return `hsl(${h % 360} 58% 46%)`
}

/** Project a video (+ its parsed transcript and any summary) onto the Episode /
 *  Podcast pair every summary renderer and exporter already understands. */
export function videoToEpisode(
  video: VideoRecord,
  segments: TranscriptSegment[],
  summary?: Episode['summary'],
): { episode: Episode; podcast: Podcast } {
  const id = encodeVideoId(video.owner, video.id)
  const title = videoTitle(video)
  const blurb =
    segments
      .map((s) => s.text)
      .join(' ')
      .slice(0, 200)
      .trim() || 'Transcript captured from YouTube by Munshot.'

  const episode: Episode = {
    id,
    podcastId: id,
    title,
    publishedAt: new Date(video.createdAt || Date.now()).toISOString(),
    durationSec: videoDuration(video, segments),
    status: summary ? 'ready' : videoProcessingStatus(video.status),
    signal: 'normal',
    blurb,
    sourceUrl: videoWatchUrl(video) || undefined,
    entities: { people: [], companies: [], themes: [] },
    transcript: segments,
    summary,
  }

  const podcast: Podcast = {
    id,
    title,
    author: video.channel || video.owner || 'YouTube',
    category: 'YouTube',
    description: blurb,
    cadence: video.channel || 'YouTube',
    episodeCount: 1,
    source: 'youtube',
    color: colorFor(id),
    monogram: (video.channel || title).replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'YT',
    artworkUrl: video.videoId ? videoThumbnail(video.videoId) : undefined,
    tracked: true,
  }

  return { episode, podcast }
}
