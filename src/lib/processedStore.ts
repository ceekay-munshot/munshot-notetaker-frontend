import type { Episode } from './types'
import { scopedKey } from './storageScope'

// ─────────────────────────────────────────────────────────────────────────────
// Processed-history persistence — the LOCAL layer.
//
// This keeps a per-browser record (localStorage, scoped per Munshot user via
// scopedKey) of the episodes you've actually processed, so that history
// survives reloads and redeploys — and stands in offline. Persisted entries
// are re-hydrated on load and overlaid onto the freshly-fetched feed; any that
// have since rolled off the feed are added back, so nothing is lost.
//
// For SIGNED-IN users the durable source of truth is the server history
// (/api/processed → KV, see server/processedStore.ts): AppData merges it over
// this cache on boot (server wins), mirrors the result back here, and re-pushes
// any local entry the server is missing (a previously failed POST self-heals).
// Anonymous visitors keep exactly this localStorage behavior, nothing more.
// ─────────────────────────────────────────────────────────────────────────────

const BASE = 'munshot:processed:v1'
const MAX = 200 // most-recent processed episodes to keep (guards localStorage quota)

/** Episodes the user has processed, most-recent first. Never throws. */
export function loadProcessed(): Episode[] {
  try {
    const raw = localStorage.getItem(scopedKey(BASE))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Keep only well-formed, genuinely-processed entries. The highlights check
    // also drops summaries persisted before the takeaways+moments merge — those
    // would crash the UI; the shared server store re-serves them on next open.
    return parsed.filter(
      (e): e is Episode =>
        !!e &&
        typeof (e as Episode).id === 'string' &&
        typeof (e as Episode).podcastId === 'string' &&
        (e as Episode).status === 'ready' &&
        Array.isArray((e as Episode).summary?.highlights),
    )
  } catch {
    return []
  }
}

/** Record a freshly-processed episode (idempotent by id). No-op if not ready. */
export function saveProcessed(episode: Episode): void {
  if (episode.status !== 'ready' || !episode.summary) return
  persistWithFallback([episode, ...loadProcessed().filter((e) => e.id !== episode.id)].slice(0, MAX))
}

/** Overwrite the whole local cache with the server-merged truth — called after
 *  boot so this browser's fallback copy matches the durable per-user history
 *  (the mirror of trackedStore's mirrorTracked, for processed episodes). */
export function mirrorProcessed(list: Episode[]): void {
  persistWithFallback(list.filter((e) => e.status === 'ready' && !!e.summary).slice(0, MAX))
}

/** The lean wire shape POSTed to /api/processed: the episode minus its two
 *  bulky artifacts. The summary/transcript live once in the GLOBAL shared cache
 *  (keyed by episode id) and re-attach on read — never duplicated per user. */
export function leanEpisode(e: Episode): Omit<Episode, 'summary' | 'transcript'> {
  const { summary: _summary, transcript: _transcript, ...lean } = e
  return lean
}

function persistWithFallback(list: Episode[]): void {
  if (persist(list)) return
  // Quota exceeded: drop the bulky transcripts but keep every summary — the
  // summary is the core of "what I've processed". (JSON.stringify omits the
  // undefined key, so the stored shape simply has no transcript.)
  persist(list.map((e) => ({ ...e, transcript: undefined })))
}

function persist(list: Episode[]): boolean {
  try {
    localStorage.setItem(scopedKey(BASE), JSON.stringify(list))
    return true
  } catch {
    return false // storage unavailable (private mode) or still over quota
  }
}
