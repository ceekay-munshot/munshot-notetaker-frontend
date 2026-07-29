import type { Episode, Podcast, WeeklyAi, WeeklySummary } from './types'
import { scopedKey } from './storageScope'
import { fetchWeeklyAiSummary, meetingRefs } from './api'
import { assembleWeekly, buildCitations, buildShowDigests, buildWeeklySources, hashKey, mergeWeeklyAi, rangeLabel } from './weeklyAssemble'

// ─────────────────────────────────────────────────────────────────────────────
// Real Weekly Summary — a "summary of summaries" built ONLY from analysed
// episodes (zero fake data). Two layers:
//
//   • Deterministic (always): the by-show digests, top themes, mentions, the
//     interesting pull-quote, source episodes, the date range — all in the pure,
//     runtime-agnostic engine (weeklyAssemble.ts), shared with the server-side
//     Monday digest so the emailed and on-screen editions are built the same way.
//   • AI narrative (when a key is configured): the cross-episode overview, the
//     key takeaways, and the open questions — synthesised by reusing the same
//     /api/summary endpoint the episodes use (no new backend). Falls back to the
//     deterministic layer's prose when there's no key or the call fails.
//
// Caching is layered. L1 (per browser): a memory map + user-scoped localStorage,
// keyed by the EDITION SCOPE (the ISO week, or 'all') — NOT the exact episode set.
// So once an edition is generated it's SAVED and shown instantly on every later
// visit, and detecting a new episode no longer silently re-runs the synthesis;
// the page surfaces "new episodes" and only Refresh (force) regenerates. L2
// (global): the AI synthesis still posts a content-derived `id`, so the shared
// summary store reuses it across ALL users — the same episode set is run through
// the model ONCE total, not once per visitor.
// ─────────────────────────────────────────────────────────────────────────────

type ById = (id: string) => Podcast | undefined

// Re-exported so existing importers (and tests) keep a stable surface.
export { buildShowDigests }

const SESSION = new Map<string, WeeklySummary>()

// In-flight generations, keyed by the scope cache key. Module-level, so a run
// SURVIVES the Weekly page unmounting on navigation: a second caller (e.g. the page
// remounting on return) re-attaches to the SAME promise instead of starting another
// — the synthesis is never lost or duplicated by leaving and coming back.
const inFlight = new Map<string, Promise<WeeklySummary | null>>()

// Saved-edition cache key — per user, per SCOPE (week key | 'all'). `:v5` retires
// the old per-episode-set keying (and the comparison-table shape before it), so a
// stale cached edition is never read after this change.
const cacheKey = (scope: string): string => scopedKey('munshot:weekly:v5') + `:${scope}`

/** The saved edition for a scope, read synchronously (memory then localStorage),
 *  WITHOUT generating. Lets the page show the saved edition instantly and decide
 *  separately whether new episodes warrant a refresh. */
export function peekWeekly(scope = 'all'): WeeklySummary | null {
  const ck = cacheKey(scope)
  return SESSION.get(ck) ?? readCache(ck)
}

/** The in-flight generation for a scope, if one is running right now (else null).
 *  Lets a remounting page re-attach to a synthesis that's still going. */
export function pendingWeekly(scope = 'all'): Promise<WeeklySummary | null> | null {
  return inFlight.get(cacheKey(scope)) ?? null
}

export interface WeeklyOptions {
  /** Disambiguates the cache entry — pass the ISO week key (or 'all'). Keeps two
   *  different views over the same episode set (a single week vs. all-time) from
   *  colliding on the content hash. */
  scope?: string
  /** Canonical label to use instead of the episodes' min/max range (e.g. the
   *  week's Mon–Sun span for a per-week edition). */
  rangeLabel?: string
  /** Skip the cache READ and regenerate from scratch (still overwrites the cache).
   *  Powers the "Refresh" button: after a format/prompt change ships, a user can
   *  force the latest version instead of being served the stale cached edition. */
  force?: boolean
}

export async function generateWeekly(
  episodes: Episode[],
  podcastById: ById,
  opts: WeeklyOptions = {},
): Promise<WeeklySummary | null> {
  const ready = episodes
    .filter((e) => e.status === 'ready' && e.summary)
    .sort((a, b) => +new Date(b.publishedAt) - +new Date(a.publishedAt))
  if (!ready.length) return null

  const scope = opts.scope || 'all'
  const ck = cacheKey(scope)
  // On a normal load, return the SAVED edition for this scope — never reprocess just
  // because a new episode was detected (the page surfaces that and offers Refresh).
  if (!opts.force) {
    const cached = SESSION.get(ck) ?? readCache(ck)
    if (cached) {
      SESSION.set(ck, cached)
      return cached
    }
  }

  // A run for this scope already going? Re-attach to it (survives navigation; never
  // double-runs the synthesis from a remount or a double-click).
  const existing = inFlight.get(ck)
  if (existing) return existing

  // Always-real deterministic base (shared engine), then the AI narrative on top.
  // The GLOBAL server id stays content-derived (episode-set hash) so the same set is
  // synthesised once across all users; only the per-browser SAVED edition is scoped.
  const run = (async () => {
    const contentKey = `${hashKey(ready)}:${scope}`
    const range = opts.rangeLabel ?? rangeLabel(ready)
    const base = assembleWeekly(ready, podcastById, { rangeLabel: range, id: `wk-${contentKey}` })
    // Guidepoint AI layer (overview, key themes, quant table, readouts, questions) with
    // the deterministic fallback baked into mergeWeeklyAi.
    const ai = await aiSynthesize(ready, range, podcastById, { scope, force: opts.force })
    const weekly = ai ? mergeWeeklyAi(base, ai) : base
    SESSION.set(ck, weekly)
    writeCache(ck, weekly)
    return weekly
  })()
  inFlight.set(ck, run)
  try {
    return await run
  } finally {
    inFlight.delete(ck)
  }
}

// ── AI narrative ──────────────────────────────────────────────────────────────
// The cross-meeting synthesis (overview + thematic key points + open questions) is
// built server-side (POST /api/weekly/summary) from each meeting's cached detailed
// summary — a real "summary of summaries". The Worker persists it per user + week,
// so once a week's edition exists it comes back cached and is never regenerated on
// a normal load; only Refresh (force) rebuilds it. `ready` is newest-first, so the
// 1-based meeting order matches the deterministic base's citation map and the
// model's `[n]` markers line up. Any failure (no key, offline, error) returns null
// and generateWeekly keeps the deterministic edition — the feature degrades, never
// breaks.
async function aiSynthesize(
  ready: Episode[],
  range: string,
  _podcastById: ById,
  opts: { scope?: string; force?: boolean } = {},
): Promise<WeeklyAi | null> {
  try {
    const res = await fetchWeeklyAiSummary(opts.scope || 'all', meetingRefs(ready), {
      range,
      force: opts.force,
    })
    return res.ai
  } catch {
    return null
  }
}

function readCache(storageKey: string): WeeklySummary | null {
  try {
    const raw = localStorage.getItem(storageKey)
    return raw ? (JSON.parse(raw) as WeeklySummary) : null
  } catch {
    return null
  }
}

function writeCache(storageKey: string, w: WeeklySummary): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(w))
  } catch {
    /* storage unavailable — fine, session cache still applies */
  }
}
