// ─────────────────────────────────────────────────────────────────────────────
// Meeting ⇄ UI-model mapping.
//
// The UI was built around a rich podcast model (Podcast + Episode + Summary in
// lib/types.ts). The real backend only knows MEETINGS: each is a group of
// transcript segments (speaker / start_time / text) keyed by meeting_id (and,
// for admin, owner_email). This module maps those segments onto the existing
// Episode/Podcast shapes so every component keeps working unchanged — one
// synthetic Podcast per meeting (1:1), and the meeting itself as the Episode.
// ─────────────────────────────────────────────────────────────────────────────

import type { Episode, Podcast, TranscriptSegment } from './types'

/** A transcript row as returned by GET /api/transcripts. */
export interface RawSegment {
  meeting_id: string | number
  segment_id?: string | number
  start_time?: number | string
  end_time?: number | string
  text?: string
  speaker?: string
  created_at?: string
  owner_email?: string
}

// An Episode id encodes the backend handle so /api/ai can be called for it.
// Emails never contain "~~", and meeting_ids are short tokens, so it round-trips.
const SEP = '~~'

export function encodeMeetingId(owner: string, meetingId: string): string {
  return `${owner}${SEP}${meetingId}`
}

export function decodeMeetingId(id: string): { owner: string; meetingId: string } {
  const i = id.indexOf(SEP)
  if (i === -1) return { owner: '', meetingId: id }
  return { owner: id.slice(0, i), meetingId: id.slice(i + SEP.length) }
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** "MM:SS" (or "H:MM:SS") for a second offset. */
export function clockTime(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = String(h > 0 ? m : m).padStart(h > 0 ? 2 : 2, '0')
  const ss = String(sec).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

// Deterministic, pleasant cover colour from the meeting id (no external art).
function colorFor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  const hue = h % 360
  return `hsl(${hue} 58% 46%)`
}

function monogramFor(speakers: string[], meetingId: string): string {
  const named = speakers.filter((s) => s && s.toLowerCase() !== 'unknown')
  if (named.length >= 2) return (named[0][0] + named[1][0]).toUpperCase()
  if (named.length === 1) return named[0].slice(0, 2).toUpperCase()
  const digits = meetingId.replace(/\D/g, '')
  return (digits.slice(-2) || meetingId.slice(0, 2) || 'MT').toUpperCase()
}

/** Distinct speakers in first-spoken order. */
function participantsOf(segs: RawSegment[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of segs) {
    const name = (s.speaker || '').trim()
    if (name && !seen.has(name)) {
      seen.add(name)
      out.push(name)
    }
  }
  return out
}

export interface Meeting {
  episode: Episode
  podcast: Podcast
}

/** Build one Meeting (Episode + synthetic Podcast) from its segments. */
function buildMeeting(meetingId: string, owner: string, segs: RawSegment[]): Meeting {
  const ordered = [...segs].sort((a, b) => num(a.start_time) - num(b.start_time))
  const id = encodeMeetingId(owner, meetingId)
  const people = participantsOf(ordered)

  // Latest created_at across the meeting → when it happened.
  let latest = ''
  for (const s of ordered) if ((s.created_at || '') > latest) latest = s.created_at || ''
  const publishedAt = latest ? new Date(latest).toISOString() : new Date(0).toISOString()

  const durationSec = ordered.reduce((mx, s) => Math.max(mx, num(s.end_time) || num(s.start_time)), 0)

  const transcript: TranscriptSegment[] = ordered.map((s, i) => ({
    id: String(s.segment_id ?? i),
    speaker: (s.speaker || 'Unknown').trim() || 'Unknown',
    role: i === 0 ? 'host' : 'guest',
    timestamp: clockTime(num(s.start_time)),
    text: s.text || '',
  }))

  const blurb =
    ordered
      .map((s) => (s.text || '').trim())
      .filter(Boolean)
      .join(' ')
      .slice(0, 200)
      .trim() || 'Transcript recorded by the Munshot notetaker.'

  const title = `Meeting ${meetingId}`

  const episode: Episode = {
    id,
    podcastId: id,
    title,
    publishedAt,
    durationSec,
    status: 'ready',
    signal: 'normal',
    blurb,
    entities: { people, companies: [], themes: [] },
    transcript,
  }

  const podcast: Podcast = {
    id,
    title,
    author: owner || 'You',
    category: 'Meeting',
    description: blurb,
    cadence: `${people.length} participant${people.length === 1 ? '' : 's'}`,
    episodeCount: 1,
    source: 'podcast',
    color: colorFor(id),
    monogram: monogramFor(people, meetingId),
    tracked: true,
  }

  return { episode, podcast }
}

/** Group raw transcript rows into meetings, most recent first. */
export function meetingsFromSegments(segments: RawSegment[]): Meeting[] {
  const groups = new Map<string, { meetingId: string; owner: string; segs: RawSegment[] }>()
  for (const s of segments) {
    const meetingId = String(s.meeting_id)
    const owner = (s.owner_email || '').trim()
    const key = `${owner}${SEP}${meetingId}`
    let g = groups.get(key)
    if (!g) {
      g = { meetingId, owner, segs: [] }
      groups.set(key, g)
    }
    g.segs.push(s)
  }
  const meetings = [...groups.values()].map((g) => buildMeeting(g.meetingId, g.owner, g.segs))
  meetings.sort((a, b) => +new Date(b.episode.publishedAt) - +new Date(a.episode.publishedAt))
  return meetings
}
