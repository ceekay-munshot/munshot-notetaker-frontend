// ─────────────────────────────────────────────────────────────────────────────
// THE SEAM — live edition.
//
// This is the data layer between the React UI and the Cloudflare Worker
// (worker/index.js). Everything the dashboard shows comes from the Worker's
// authenticated /api/* routes; the session is an HttpOnly cookie, so requests
// just carry credentials. Transcript segments are mapped onto the UI's existing
// Episode/Podcast model in lib/meetings.ts, so components stay unchanged.
//
// A few podcast-era exports (directory search, video resolve, the weekly EMAIL
// digest) have no meeting backend and remain inert no-ops so their callers keep
// compiling; they are hidden in the meetings UI.
// ─────────────────────────────────────────────────────────────────────────────

import type { Episode, Podcast, Summary, WeeklySchedule, WeeklySummary } from './types'
import type { EmailResult } from './email'
import { normalizeRecipients } from './recipientsStore'
import { meetingsFromSegments, decodeMeetingId, type RawSegment } from './meetings'

/** Thrown when an /api call comes back 401 — the session expired or is missing. */
export class NotAuthedError extends Error {
  constructor() {
    super('not_authenticated')
    this.name = 'NotAuthedError'
  }
}

/** Generic API failure carrying the server's human message. */
export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/** Kept for back-compat with the old summary pipeline. No longer thrown. */
export class NoApiKeyError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })
  let data: any = null
  try {
    data = await res.json()
  } catch {
    /* non-JSON (e.g. an asset 404) — leave data null */
  }
  if (res.status === 401) throw new NotAuthedError()
  if (!res.ok) throw new ApiError((data && (data.error || data.detail)) || `Request failed (${res.status})`, res.status)
  return data as T
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export interface Me {
  authenticated: boolean
  email?: string
  isAdmin?: boolean
  codeRequired?: boolean
}

/** Probe the session. Returns the signed-in user or an unauthenticated marker
 *  (never throws on 401 — that IS the answer the login screen needs). */
export async function getMe(): Promise<Me> {
  const res = await fetch('/api/me', { credentials: 'same-origin' })
  const data = (await res.json().catch(() => ({}))) as Me
  if (res.status === 401) return { authenticated: false, codeRequired: !!data.codeRequired }
  return { ...data, authenticated: true }
}

export function login(email: string, password: string): Promise<{ ok: boolean; admin?: boolean; email?: string }> {
  return request('/api/login', { method: 'POST', body: JSON.stringify({ email, password }) })
}

export function register(email: string, password: string, code?: string): Promise<{ ok: boolean; email?: string }> {
  return request('/api/register', { method: 'POST', body: JSON.stringify({ email, password, code }) })
}

export function logout(): Promise<{ ok: boolean }> {
  return request('/api/logout', { method: 'POST' })
}

/** Step 1 of a password reset: the server emails a single-use, 15-minute 5-digit
 *  code to the address (if an account exists) — the account's password is left
 *  unchanged until step 2. Always resolves the same way regardless of whether the
 *  account exists, so it can't be used to probe registrations. */
export function forgotPassword(email: string): Promise<{ ok: boolean }> {
  return request('/api/forgot-password', { method: 'POST', body: JSON.stringify({ email }) })
}

/** Step 2 of a password reset: verify the emailed code and set a new password.
 *  The code is single-use, attempt-limited, and expiring; a wrong/expired code
 *  comes back as ApiError("Invalid or expired reset code"). */
export function resetPassword(email: string, code: string, password: string): Promise<{ ok: boolean }> {
  return request('/api/reset-password', { method: 'POST', body: JSON.stringify({ email, code, password }) })
}

// ── Meetings (transcripts → Episode/Podcast model) ──────────────────────────────

export interface MeetingData {
  episodes: Episode[]
  podcasts: Podcast[]
  admin: boolean
}

/** Load every meeting the signed-in user can see and map it onto the UI model. */
export async function fetchMeetings(): Promise<MeetingData> {
  const data = await request<{
    ok: boolean
    admin?: boolean
    segments?: RawSegment[]
    titles?: Record<string, string>
  }>('/api/transcripts')
  const meetings = meetingsFromSegments(data.segments || [], data.titles || {})
  return {
    episodes: meetings.map((m) => m.episode),
    podcasts: meetings.map((m) => m.podcast),
    admin: !!data.admin,
  }
}

// Turn the assistant's markdown reply into the Summary shape the UI renders.
// We only fill `synthesis` (the readable body); the finance-only modules
// (ideas, tone, quant, investment readout) stay empty and hide themselves.
function summaryFromReply(reply: string): Summary {
  const synthesis = reply
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
  return { synthesis: synthesis.length ? synthesis : [reply.trim()], highlights: [], qa: [] }
}

/** Ask the meeting assistant for a one-page summary of a meeting (OpenAI, server-side).
 *  The Worker generates a summary once and caches it, so every co-owner sees the
 *  same one; pass { force } (the Refresh button) to regenerate and overwrite it.
 *  `title` is the AI-minted display name for an otherwise-unnamed meeting (also
 *  generated once, while summarizing) — undefined when the meeting already has one
 *  or naming failed. */
export async function summarizeMeeting(
  episode: Episode,
  opts?: { force?: boolean; hasName?: boolean },
): Promise<{ summary: Summary; title?: string }> {
  const { owner, meetingId } = decodeMeetingId(episode.id)
  // has_name tells the Worker the meeting already carries a real (calendar) name,
  // so it should NOT mint an AI title — only nameless meetings get one.
  const data = await request<{ ok: boolean; reply?: string; title?: string }>('/api/ai', {
    method: 'POST',
    body: JSON.stringify({ meeting_id: meetingId, owner, summarize: true, force: !!opts?.force, has_name: !!opts?.hasName }),
  })
  const title = typeof data.title === 'string' ? data.title.trim() : ''
  return { summary: summaryFromReply(String(data.reply || '')), title: title || undefined }
}

/** Free-form chat over a single meeting's transcript. `messages` is the running
 *  conversation ([{role:'user'|'assistant', content}]). Returns the reply text. */
export async function chatMeeting(
  episode: Episode,
  messages: { role: 'user' | 'assistant'; content: string }[],
): Promise<string> {
  const { owner, meetingId } = decodeMeetingId(episode.id)
  const data = await request<{ ok: boolean; reply?: string }>('/api/ai', {
    method: 'POST',
    body: JSON.stringify({ meeting_id: meetingId, owner, messages }),
  })
  return String(data.reply || '')
}

// ── Weekly per-person rollup ────────────────────────────────────────────────────

export interface PersonRollup {
  name: string
  overall: string
  accomplished: string[]
  todo: string[]
}

/** A per-person status rollup across all the signed-in user's meetings: overall
 *  view, what each participant has accomplished, and their current to-dos. */
export async function fetchWeeklyPeople(): Promise<PersonRollup[]> {
  const data = await request<{ ok: boolean; people?: PersonRollup[] }>('/api/weekly/people', {
    method: 'POST',
    body: '{}',
  })
  return data.people || []
}

// ── The notetaker bot ───────────────────────────────────────────────────────────

export function sendBot(
  meetingUrl: string,
  action: 'join' | 'leave' = 'join',
): Promise<{ ok: boolean; status: number; response: unknown }> {
  return request(`/api/${action}`, { method: 'POST', body: JSON.stringify({ meeting_url: meetingUrl }) })
}

// ── Schedules ───────────────────────────────────────────────────────────────────

export interface Schedule {
  id: string
  meetingUrl: string
  nextRun: number
  recurrence: 'once' | 'daily' | 'weekdays' | 'weekly'
  timeZone: string
  lastRun: number | null
  lastStatus: string | null
}

export interface NewSchedule {
  meeting_url: string
  /** "YYYY-MM-DDTHH:MM" wall-clock, as picked. */
  local_datetime: string
  recurrence: 'once' | 'daily' | 'weekdays' | 'weekly'
  /** IANA zone the wall-clock is in. */
  time_zone: string
}

export async function listSchedules(): Promise<Schedule[]> {
  const data = await request<{ ok: boolean; schedules?: Schedule[] }>('/api/schedules')
  return data.schedules || []
}

export async function createSchedule(input: NewSchedule): Promise<Schedule> {
  const data = await request<{ ok: boolean; schedule: Schedule }>('/api/schedules', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return data.schedule
}

export function deleteSchedule(id: string): Promise<{ ok: boolean }> {
  return request('/api/schedules/delete', { method: 'POST', body: JSON.stringify({ id }) })
}

// ── Calendar ────────────────────────────────────────────────────────────────────

export interface CalendarEvent {
  id?: number | string
  meeting_url?: string
  url?: string
  title?: string
  summary?: string
  start?: string
  start_time?: string
  end_time?: string
  platform?: string
  status?: string
  meeting_id?: number | string | null
  [k: string]: unknown
}

export function calendarSync(): Promise<{ ok: boolean; status: number; result: unknown }> {
  return request('/api/calendar/sync', { method: 'POST', body: '{}' })
}

/** Returns the raw calendar payload from upstream; shape is normalized by the caller.
 *  Pass includeCancelled to also get removed (status "cancelled") meetings. */
export async function calendarMeetings(includeCancelled = false): Promise<{ ok: boolean; status: number; calendar: any }> {
  return request('/api/calendar/meetings' + (includeCancelled ? '?include_cancelled=true' : ''))
}

/** Remove a scheduled/upcoming calendar meeting so the bot won't join it. */
export function calendarRemove(eventId: number | string): Promise<{ ok: boolean; status: number; result: unknown }> {
  return request('/api/calendar/meetings/remove', { method: 'POST', body: JSON.stringify({ event_id: eventId }) })
}

/** Restore (unremove) a cancelled calendar meeting so the bot will join it again. */
export function calendarRestore(eventId: number | string): Promise<{ ok: boolean; status: number; result: unknown }> {
  return request('/api/calendar/meetings/restore', { method: 'POST', body: JSON.stringify({ event_id: eventId }) })
}

// ─────────────────────────────────────────────────────────────────────────────
// Inert podcast-era exports — no meeting backend. Kept so their callers compile;
// the corresponding UI is hidden in the meetings build.
// ─────────────────────────────────────────────────────────────────────────────

export function searchPodcasts(_query: string, _signal?: AbortSignal, _limit?: number): Promise<never[]> {
  return Promise.resolve([])
}

export function resolveVideo(_query: string, _signal?: AbortSignal): Promise<string | null> {
  return Promise.resolve(null)
}

export function subscribeWeekly(
  email: string,
  _opts: { name?: string } = {},
): Promise<{ subscribed: boolean; email: string; message: string }> {
  return Promise.resolve({ subscribed: true, email, message: "You'll get the weekly meetings digest." })
}

export function unsubscribeWeekly(email: string): Promise<{ subscribed: boolean; email: string }> {
  return Promise.resolve({ subscribed: false, email })
}

export function registerWeeklyRecipient(_email: string): Promise<void> {
  return Promise.resolve()
}

export function unregisterWeeklyRecipient(_email: string): Promise<void> {
  return Promise.resolve()
}

export function getWeeklySchedule(): Promise<WeeklySchedule | null> {
  return Promise.resolve(null)
}

export function setWeeklySchedule(
  s: WeeklySchedule,
): Promise<{ ok: boolean; schedule?: WeeklySchedule; message?: string }> {
  return Promise.resolve({ ok: true, schedule: s })
}

export async function emailWeeklyEdition(
  recipients: string | string[],
  _weekly: WeeklySummary,
  _episodeById: (id: string) => Episode | undefined,
  _podcastById: (id: string) => Podcast | undefined,
): Promise<EmailResult> {
  const to = normalizeRecipients(undefined, Array.isArray(recipients) ? recipients : [recipients])
  if (!to.length) return { ok: false, message: 'No valid recipient to send to.' }
  return { ok: true, message: to.length === 1 ? `Sent to ${to[0]}` : `Sent to ${to.length} recipients` }
}

export async function emailEpisodeSummary(
  recipients: string | string[],
  episode: Episode,
  _podcast?: Podcast,
): Promise<EmailResult> {
  if (!episode.summary) return { ok: false, message: 'This meeting has no summary to send yet.' }
  const to = normalizeRecipients(undefined, Array.isArray(recipients) ? recipients : [recipients])
  if (!to.length) return { ok: false, message: 'No valid recipient to send to.' }
  return { ok: true, message: to.length === 1 ? `Sent to ${to[0]}` : `Sent to ${to.length} recipients` }
}
