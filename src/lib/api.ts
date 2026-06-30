import type { Episode, Podcast, PodcastSearchResult, Summary, TranscriptSegment, WeeklySchedule, WeeklySummary } from './types'
import { EPISODES, PODCASTS, WEEKLY } from './mock-data'
import type { EmailResult } from './email'
import { normalizeRecipients } from './recipientsStore'

// ─────────────────────────────────────────────────────────────────────────────
// THE SEAM — visual-shell edition.
//
// Every function returns the same shape a real backend would, but resolves
// purely from in-memory mock data (or an inert success). NOTHING here makes a
// network call: this is a front-end-only prototype with no backend. To go live
// again, replace each body with a real `fetch()` — no component changes, since
// no component imports mock data directly.
// ─────────────────────────────────────────────────────────────────────────────

const LATENCY = 240 // ms — just enough to exercise loading states.

function delay<T>(value: T, ms = LATENCY): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

// Clone so the UI can mutate its own copy without corrupting the "server".
function clone<T>(value: T): T {
  return structuredClone(value)
}

export function listPodcasts(): Promise<Podcast[]> {
  return delay(clone(PODCASTS))
}

export function listEpisodes(): Promise<Episode[]> {
  return delay(clone(EPISODES))
}

export function getEpisode(id: string): Promise<Episode | undefined> {
  return delay(clone(EPISODES.find((e) => e.id === id)))
}

export function getWeekly(): Promise<WeeklySummary> {
  return delay(clone(WEEKLY))
}

// ── Channel roster ───────────────────────────────────────────────────────────
// No backend roster in the shell: the app falls back to its seed shows, and any
// track/untrack is persisted only in this browser's localStorage (trackedStore).

export function listChannels(): Promise<Podcast[]> {
  return delay([])
}

export function upsertChannel(_podcast: Podcast): Promise<boolean> {
  return delay(true)
}

export function migrateChannels(_podcasts: Podcast[]): Promise<boolean> {
  return delay(true)
}

// ── Processed history ─────────────────────────────────────────────────────────
// No durable per-user backend: the browser's localStorage (processedStore) is the
// only record, so the "remote" history is always empty and writes are inert.

export function listProcessed(): Promise<Episode[]> {
  return delay([])
}

export function saveProcessedRemote(_episode: Omit<Episode, 'summary' | 'transcript'>): Promise<boolean> {
  return delay(true)
}

export class NoApiKeyError extends Error {}

// No LLM backend in the shell, so on-demand summarisation is unavailable.
// Throwing NoApiKeyError drives the app's built-in "connect a key" state — the
// episode reverts to 'detected' rather than showing a fake "failed". Episodes
// that already carry a summary in the mock data render normally.
export async function generateSummary(_input: {
  id?: string
  title: string
  show: string
  notes?: string
  transcriptUrl?: string
  audioUrl?: string
  force?: boolean
}): Promise<{ summary: Summary; transcript?: TranscriptSegment[] }> {
  throw new NoApiKeyError('no_api_key')
}

// ── Weekly subscription / recipients / schedule ───────────────────────────────
// All inert in the shell — no email is sent and no list is stored. The UI's
// happy path renders; nothing is delivered.

export function subscribeWeekly(email: string, _opts: { name?: string } = {}): Promise<{ subscribed: boolean; email: string; message: string }> {
  return delay({ subscribed: true, email, message: "You're subscribed (demo — no email is sent in this build)." })
}

export function unsubscribeWeekly(email: string): Promise<{ subscribed: boolean; email: string }> {
  return delay({ subscribed: false, email })
}

export function registerWeeklyRecipient(_email: string): Promise<void> {
  return delay(undefined)
}

export function unregisterWeeklyRecipient(_email: string): Promise<void> {
  return delay(undefined)
}

export function getWeeklySchedule(): Promise<WeeklySchedule | null> {
  return delay(null) // no saved schedule — the editor shows its defaults
}

export function setWeeklySchedule(s: WeeklySchedule): Promise<{ ok: boolean; schedule?: WeeklySchedule; message?: string }> {
  return delay({ ok: true, schedule: s })
}

// On-demand sends — validate recipients exactly as before, then resolve an inert
// success. Nothing is rendered to a PDF, hosted, or delivered.
export async function emailWeeklyEdition(
  recipients: string | string[],
  _weekly: WeeklySummary,
  _episodeById: (id: string) => Episode | undefined,
  _podcastById: (id: string) => Podcast | undefined,
): Promise<EmailResult> {
  const to = normalizeRecipients(undefined, Array.isArray(recipients) ? recipients : [recipients])
  if (!to.length) return { ok: false, message: 'No valid recipient to send to.' }
  return { ok: true, message: to.length === 1 ? `Sent to ${to[0]} (demo)` : `Sent to ${to.length} recipients (demo)` }
}

export async function emailEpisodeSummary(
  recipients: string | string[],
  episode: Episode,
  _podcast?: Podcast,
): Promise<EmailResult> {
  if (!episode.summary) return { ok: false, message: 'This episode has no summary to send yet.' }
  const to = normalizeRecipients(undefined, Array.isArray(recipients) ? recipients : [recipients])
  if (!to.length) return { ok: false, message: 'No valid recipient to send to.' }
  return { ok: true, message: to.length === 1 ? `Sent to ${to[0]} (demo)` : `Sent to ${to.length} recipients (demo)` }
}

// ── Directory search / video resolve / feed ingest ────────────────────────────
// No backend and no live feeds in the shell, so these are inert: search returns
// no matches, video resolution returns null (the UI falls back to an external
// link), and feed ingestion adds nothing (the mock episodes are all there is).

export function searchPodcasts(_query: string, _signal?: AbortSignal, _limit?: number): Promise<PodcastSearchResult[]> {
  return Promise.resolve([])
}

export function resolveVideo(_query: string, _signal?: AbortSignal): Promise<string | null> {
  return Promise.resolve(null)
}

export function fetchFeedEpisodes(_feedUrl: string, _podcastId: string): Promise<Episode[]> {
  return Promise.resolve([])
}
