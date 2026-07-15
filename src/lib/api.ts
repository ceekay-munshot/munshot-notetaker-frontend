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

import type { Episode, Podcast, Summary, WeeklyAi, WeeklySchedule, WeeklySummary } from './types'
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

/** Exchanges a Munshot host JWT for a real Worker session cookie, so /api/*
 *  calls made from inside the host iframe are authenticated. See the security
 *  caveat on the Worker's handleHostLogin — the token's signature isn't
 *  verified server-side. */
export function hostLogin(token: string): Promise<{ ok: boolean; email?: string }> {
  return request('/api/host-login', { method: 'POST', body: JSON.stringify({ token }) })
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

/** Pushes real calendar names (from this browser's own calendar sync) for
 *  meetings the signed-in user owns into the Worker's shared title cache, so a
 *  viewer without their own calendar view of a meeting (chiefly admin) sees
 *  the real name too — instead of a stale/AI title lingering until the
 *  meeting is individually reopened. Best-effort; failures are non-fatal. */
export async function syncMeetingTitles(
  names: { meetingId: string; calendarName: string }[],
): Promise<void> {
  if (!names.length) return
  await request('/api/meetings/sync-titles', {
    method: 'POST',
    body: JSON.stringify({ names: names.map((n) => ({ meeting_id: n.meetingId, calendar_name: n.calendarName })) }),
  })
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
  opts?: { force?: boolean; calendarName?: string },
): Promise<{ summary: Summary; title?: string }> {
  const { owner, meetingId } = decodeMeetingId(episode.id)
  const calendarName = opts?.calendarName?.trim()
  // calendar_name tells the Worker the meeting already carries a real (calendar)
  // name, so it should store THAT as the meeting's title instead of minting an
  // AI one — only a meeting with no calendar name gets one.
  const data = await request<{ ok: boolean; reply?: string; title?: string }>('/api/ai', {
    method: 'POST',
    body: JSON.stringify({
      meeting_id: meetingId,
      owner,
      summarize: true,
      force: !!opts?.force,
      has_name: !!calendarName,
      calendar_name: calendarName || undefined,
    }),
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
 *  view, what each participant has accomplished, and their current to-dos. The
 *  Worker persists this per user and only rebuilds it when the meetings change;
 *  pass { force } (the "Regenerate" button) to rebuild it on demand. */
export async function fetchWeeklyPeople(opts?: { force?: boolean }): Promise<PersonRollup[]> {
  const data = await request<{ ok: boolean; people?: PersonRollup[] }>('/api/weekly/people', {
    method: 'POST',
    body: JSON.stringify({ force: !!opts?.force }),
  })
  return data.people || []
}

// ── Weekly master summary ("summary of summaries") ───────────────────────────────
// The cross-meeting synthesis is built server-side from each meeting's cached
// detailed summary and persisted per user + week, so once a week's summary exists
// it is returned as-is and never regenerated on a normal visit (only Refresh /
// force rebuilds it). Each meeting carries its 1-based `index` so the model's
// `[n]` citations line up with the client's deterministic source order.

/** A meeting reference the weekly endpoints authorize + read the summary for. */
export interface WeeklyMeetingRef {
  meeting_id: string
  owner: string
  /** 1-based citation index in the client's source order (for [n] alignment). */
  index?: number
}

export interface WeeklyAiResult {
  /** The synthesised narrative, or null when no meeting in the week is summarized yet. */
  ai: WeeklyAi | null
  /** True when the saved edition was returned (not freshly generated). */
  cached: boolean
  generatedAt: number | null
  /** How many of the requested meetings actually had a summary to synthesise from. */
  usedCount: number
  skipped: number
}

/** Turn a set of episodes into the meeting refs the weekly endpoints expect,
 *  numbered 1-based in the given (source) order for citation alignment. */
export function meetingRefs(episodes: Episode[]): WeeklyMeetingRef[] {
  return episodes.map((e, i) => {
    const { owner, meetingId } = decodeMeetingId(e.id)
    return { meeting_id: meetingId, owner, index: i + 1 }
  })
}

/** Build (or fetch the saved) weekly master summary for a week bucket. Returns
 *  `ai: null` when none of the week's meetings are summarized yet. */
export async function fetchWeeklyAiSummary(
  week: string,
  meetings: WeeklyMeetingRef[],
  opts: { range?: string; force?: boolean } = {},
): Promise<WeeklyAiResult> {
  const data = await request<{
    ok: boolean
    ai?: WeeklyAi | null
    cached?: boolean
    generatedAt?: number | null
    usedCount?: number
    skipped?: number
  }>('/api/weekly/summary', {
    method: 'POST',
    body: JSON.stringify({ week, range: opts.range || '', force: !!opts.force, meetings }),
  })
  return {
    ai: data.ai ?? null,
    cached: !!data.cached,
    generatedAt: data.generatedAt ?? null,
    usedCount: data.usedCount ?? 0,
    skipped: data.skipped ?? 0,
  }
}

/** A meeting's server-cached detailed summary, mapped onto the UI Summary shape. */
export interface CachedMeetingSummary {
  meetingId: string
  title: string
  summary: Summary
}

/** Peek the already-cached detailed summary for each requested meeting (no
 *  generation). Lets the Weekly page hydrate its episode model from summaries the
 *  auto-summary cron / prior opens already produced, so the weekly populates
 *  without opening every meeting. Meetings without a cached summary are omitted. */
export async function fetchCachedMeetingSummaries(meetings: WeeklyMeetingRef[]): Promise<CachedMeetingSummary[]> {
  if (!meetings.length) return []
  const data = await request<{
    ok: boolean
    summaries?: { meeting_id: string; title: string; summary: string }[]
  }>('/api/weekly/meetings', {
    method: 'POST',
    body: JSON.stringify({ meetings }),
  })
  return (data.summaries || []).map((s) => ({
    meetingId: String(s.meeting_id),
    title: String(s.title || ''),
    summary: summaryFromReply(String(s.summary || '')),
  }))
}

/** Free-form chat over a week's meeting summaries + the saved master summary.
 *  `messages` is the running conversation; returns the assistant's reply. */
export async function chatWeekly(
  week: string,
  meetings: WeeklyMeetingRef[],
  messages: { role: 'user' | 'assistant'; content: string }[],
): Promise<string> {
  const data = await request<{ ok: boolean; reply?: string }>('/api/weekly/chat', {
    method: 'POST',
    body: JSON.stringify({ week, meetings, messages }),
  })
  return String(data.reply || '')
}

// ── Admin people tracker ─────────────────────────────────────────────────────
// Admin picks a set of people to track across ALL meetings (not just the
// caller's own); the Worker's cron keeps each person's rollup updated as new
// meetings mention them. Every /api/tracking* route is admin-only.

export interface TrackedPerson extends PersonRollup {
  slug: string
  meetingCount: number
  updatedAt: number | null
  /** True until the background cron has produced a real rollup for a
   *  just-added name — the UI should poll fetchTracking() while this is set. */
  pending?: boolean
}

export interface TrackingWatermark {
  n: number
  lastRegenAt: number
}

export interface TrackingState {
  selection: string[]
  people: TrackedPerson[]
  watermark: TrackingWatermark | null
}

/** Every distinct named speaker across every meeting, for the tracking picker. */
export async function fetchTrackingDirectory(): Promise<string[]> {
  const data = await request<{ ok: boolean; people?: string[] }>('/api/tracking/directory')
  return data.people || []
}

/** Current tracked selection + each person's latest rollup (or a pending
 *  placeholder). Poll this while any person is `pending`. */
export async function fetchTracking(): Promise<TrackingState> {
  const data = await request<{
    ok: boolean
    selection?: string[]
    people?: TrackedPerson[]
    watermark?: TrackingWatermark | null
  }>('/api/tracking')
  return { selection: data.selection || [], people: data.people || [], watermark: data.watermark ?? null }
}

/** Persists the tracked-people selection. Returns immediately — a newly added
 *  name's rollup is built by the background cron, not generated inline. */
export async function saveTrackingSelection(names: string[]): Promise<string[]> {
  const data = await request<{ ok: boolean; selection?: string[] }>('/api/tracking', {
    method: 'POST',
    body: JSON.stringify({ names }),
  })
  return data.selection || []
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

/** A schedule as admin sees it — every user's, each tagged with its owner. */
export interface AdminSchedule extends Schedule {
  owner: string
}

export interface NewSchedule {
  meeting_url: string
  /** "YYYY-MM-DDTHH:MM" wall-clock, as picked. */
  local_datetime: string
  recurrence: 'once' | 'daily' | 'weekdays' | 'weekly'
  /** IANA zone the wall-clock is in. */
  time_zone: string
}

/** A signed-in user's own schedules. Admins have none of their own — use
 *  adminListSchedules for the cross-user view. */
export async function listSchedules(): Promise<Schedule[]> {
  const data = await request<{ ok: boolean; schedules?: Schedule[] }>('/api/schedules')
  return data.schedules || []
}

/** Admin-only: every user's schedules (each tagged with its owner), or just one
 *  user's when `email` is given. */
export async function adminListSchedules(email?: string): Promise<AdminSchedule[]> {
  const qs = email ? `?email=${encodeURIComponent(email)}` : ''
  const data = await request<{ ok: boolean; schedules?: AdminSchedule[] }>(`/api/schedules${qs}`)
  return data.schedules || []
}

export async function createSchedule(input: NewSchedule): Promise<Schedule> {
  const data = await request<{ ok: boolean; schedule: Schedule }>('/api/schedules', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return data.schedule
}

/** Cancel a schedule. Pass `owner` when acting as admin on another user's
 *  schedule — a normal user's own session always deletes only their own. */
export function deleteSchedule(id: string, owner?: string): Promise<{ ok: boolean }> {
  return request('/api/schedules/delete', { method: 'POST', body: JSON.stringify({ id, owner }) })
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

/** Normalizes whatever shape the upstream calendar endpoint returns (a bare
 *  array, or one of a few wrapper keys) into a flat event list. */
export function normalizeCalendarEvents(payload: any): CalendarEvent[] {
  if (!payload) return []
  const arr = Array.isArray(payload)
    ? payload
    : payload.calendar_events || payload.meetings || payload.events || payload.items || payload.calendar || []
  return Array.isArray(arr) ? arr : []
}

export function calendarSync(): Promise<{ ok: boolean; status: number; result: unknown }> {
  return request('/api/calendar/sync', { method: 'POST', body: '{}' })
}

/** Returns the raw calendar payload from upstream; shape is normalized by the caller.
 *  Pass includeCancelled to also get removed (status "cancelled") meetings. `email`
 *  is admin-only — it names which user's calendar to read (admins have none of
 *  their own); a normal user's session always reads their own calendar. */
export async function calendarMeetings(
  includeCancelled = false,
  email?: string,
): Promise<{ ok: boolean; status: number; calendar: any }> {
  const params = new URLSearchParams()
  if (includeCancelled) params.set('include_cancelled', 'true')
  if (email) params.set('email', email)
  const qs = params.toString()
  return request('/api/calendar/meetings' + (qs ? `?${qs}` : ''))
}

/** Remove a scheduled/upcoming calendar meeting so the bot won't join it. `email`
 *  is admin-only — the user to act as. */
export function calendarRemove(
  eventId: number | string,
  email?: string,
): Promise<{ ok: boolean; status: number; result: unknown }> {
  return request('/api/calendar/meetings/remove', {
    method: 'POST',
    body: JSON.stringify({ event_id: eventId, email }),
  })
}

/** Restore (unremove) a cancelled calendar meeting so the bot will join it again.
 *  `email` is admin-only — the user to act as. */
export function calendarRestore(
  eventId: number | string,
  email?: string,
): Promise<{ ok: boolean; status: number; result: unknown }> {
  return request('/api/calendar/meetings/restore', {
    method: 'POST',
    body: JSON.stringify({ event_id: eventId, email }),
  })
}

/** Admin-only: every distinct user email that has (or has had) meetings or
 *  schedules — feeds the "Scheduled Meetings" admin picker. */
export async function adminListUsers(): Promise<string[]> {
  const data = await request<{ ok: boolean; users?: string[] }>('/api/admin/users')
  return data.users || []
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
