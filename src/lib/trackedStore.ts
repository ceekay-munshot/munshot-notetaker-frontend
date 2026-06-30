import type { Podcast } from './types'
import { scopedKey } from './storageScope'

// ─────────────────────────────────────────────────────────────────────────────
// Local MIRROR of the user-added side of the channel roster (per browser/origin,
// scoped per Munshot user via scopedKey — anonymous keeps the legacy key).
//
// The durable source of truth is the server roster (/api/channels → KV; see
// server/channelStore.ts) — per user when identified, and it survives deploys.
// This localStorage copy is the offline fallback (server unreachable → the list
// still renders) and the migration source: entries saved here before the backend
// store existed are pushed up once on boot (see AppData). Seed/curated shows are
// NOT stored here — their tracked overrides live only in the server roster —
// so this only ever holds genuinely user-added feeds. Mirrors processedStore.ts.
// ─────────────────────────────────────────────────────────────────────────────

const BASE = 'munshot:tracked:v1'
const MAX = 100 // guards the localStorage quota

function isValid(p: unknown): p is Podcast {
  if (!p || typeof p !== 'object') return false
  const x = p as Record<string, unknown>
  const str = (k: string) => typeof x[k] === 'string' && (x[k] as string).length >= 0
  return (
    typeof x.id === 'string' &&
    !!x.id &&
    str('title') &&
    str('author') &&
    str('category') &&
    str('description') &&
    str('color') &&
    str('monogram') &&
    typeof x.feedUrl === 'string' &&
    !!x.feedUrl &&
    (x.source === 'podcast' || x.source === 'youtube') &&
    x.tracked === true
  )
}

/** User-added podcasts, most-recent first. Never throws; drops malformed rows. */
export function loadTracked(): Podcast[] {
  try {
    const raw = localStorage.getItem(scopedKey(BASE))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isValid) : []
  } catch {
    return []
  }
}

/** Record a user-added podcast (idempotent by id, forced tracked:true). */
export function saveTracked(podcast: Podcast): void {
  if (!isValid({ ...podcast, tracked: true })) return
  const entry = { ...podcast, tracked: true }
  const next = [entry, ...loadTracked().filter((p) => p.id !== podcast.id)].slice(0, MAX)
  persist(next)
}

/** Forget a user-added podcast. */
export function removeTracked(id: string): void {
  persist(loadTracked().filter((p) => p.id !== id))
}

/** Overwrite the whole local mirror — called after boot so this browser's
 *  fallback copy matches the server roster (plus anything just migrated). */
export function mirrorTracked(list: Podcast[]): void {
  persist(
    list
      .map((p) => ({ ...p, tracked: true as const }))
      .filter((p) => isValid(p))
      .slice(0, MAX),
  )
}

function persist(list: Podcast[]): void {
  try {
    localStorage.setItem(scopedKey(BASE), JSON.stringify(list))
  } catch {
    /* storage unavailable (private mode) or over quota — adds still work in-session */
  }
}
