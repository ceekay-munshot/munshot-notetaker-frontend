import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Episode, Podcast, ProcessingStatus, WeeklySummary } from '../lib/types'
import * as api from '../lib/api'
import { setApiUser } from '../lib/apiFetch'
import { getIdentity, onIdentityChange, resolveIdentity, type Identity } from '../lib/munshot'
import { setStorageUser } from '../lib/storageScope'
import { leanEpisode, loadProcessed, mirrorProcessed, saveProcessed } from '../lib/processedStore'
import { loadTracked, mirrorTracked, removeTracked, saveTracked } from '../lib/trackedStore'

// One provider loads everything through the api seam and hands it to the app
// via context, so individual pages stay synchronous and snappy. The boot fetch
// is gated on the Munshot identity (resolved from the host when embedded), so
// a signed-in user only ever sees THEIR roster — never a flash of another
// user's (or the anonymous) data — and a mid-session user switch re-runs the
// whole load against the new user's stores.

interface AppData {
  loading: boolean
  podcasts: Podcast[]
  episodes: Episode[]
  weekly: WeeklySummary | null
  /** The Munshot host identity scoping this session's data:
   *  undefined = still resolving, null = anonymous (shared space). */
  identity: Identity | null | undefined
  /** True once a summary request came back "no API key configured". */
  needsApiKey: boolean
  // selectors
  podcastById: (id: string) => Podcast | undefined
  episodeById: (id: string) => Episode | undefined
  episodesByPodcast: (podcastId: string) => Episode[]
  // mutations
  toggleTracked: (id: string) => void
  /** Track a podcast from a directory search result: merges it into the list,
   *  persists it (localStorage), and detects its recent episodes. */
  addPodcast: (podcast: Podcast) => void
  /** Generate a real AI summary for an episode from its show-notes (idempotent).
   *  Pass `{ force: true }` to regenerate an already-summarized episode, bypassing
   *  the server + client caches (the Refresh button). */
  summarizeEpisode: (episode: Episode, podcast?: Podcast, opts?: { force?: boolean }) => Promise<void>
  /** Bulk "process this week" — summarises the given episodes sequentially. Lives in
   *  the provider so the run KEEPS GOING across navigation and the page re-attaches to
   *  its live `weekProgress` on return. No-op if one is already running. */
  weekProcessing: boolean
  weekProgress: { done: number; total: number; title: string }
  processWeek: (targets: Episode[]) => Promise<void>
  /** Stop the bulk run after the current episode finishes. */
  cancelProcessWeek: () => void
}

const Ctx = createContext<AppData | null>(null)

// Pipeline order driving the simulated processing progression below.
const PIPELINE_ORDER: ProcessingStatus[] = ['detected', 'fetching', 'transcribing', 'summarizing', 'ready']

function nextStatus(status: ProcessingStatus): ProcessingStatus | null {
  if (status === 'ready' || status === 'failed') return null
  const i = PIPELINE_ORDER.indexOf(status)
  return i >= 0 && i < PIPELINE_ORDER.length - 1 ? PIPELINE_ORDER[i + 1] : null
}

// Compare a feed URL ignoring trivial formatting differences (trailing slash, host case).
function canonicalFeed(url?: string): string {
  if (!url) return ''
  try {
    const u = new URL(url.trim())
    return `${u.protocol}//${u.hostname.toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.search}`
  } catch {
    return url.trim().toLowerCase()
  }
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

// Layered identity for de-duping an added podcast against the existing list:
// same id → same canonical feed → same normalized title + author. (Not title
// alone — iTunes author strings can differ from curated seed authors.)
function samePodcast(a: Podcast, b: Podcast): boolean {
  if (a.id === b.id) return true
  const af = canonicalFeed(a.feedUrl)
  const bf = canonicalFeed(b.feedUrl)
  if (af && bf && af === bf) return true
  return norm(a.title) === norm(b.title) && norm(a.author) === norm(b.author)
}

export function AppDataProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true)
  const [podcasts, setPodcasts] = useState<Podcast[]>([])
  const [episodes, setEpisodes] = useState<Episode[]>([])
  const [weekly, setWeekly] = useState<WeeklySummary | null>(null)
  const [needsApiKey, setNeedsApiKey] = useState(false)
  const summarizing = useRef<Set<string>>(new Set()) // episode ids with an in-flight summary request
  // Bulk "process this week" — held in the provider so it survives page navigation.
  const [weekProcessing, setWeekProcessing] = useState(false)
  const [weekProgress, setWeekProgress] = useState({ done: 0, total: 0, title: '' })
  const weekCancel = useRef(false)
  const weekRunning = useRef(false) // guards against a second run while one is live
  // Ids in the seed/curated list — lets the mutation callbacks tell a user-added
  // show (which we persist + prune) from a built-in one. Populated on load.
  const seedIds = useRef<Set<string>>(new Set())
  // Latest podcasts mirrored into a ref so the stable callbacks below can read the
  // current list without being re-created (and re-subscribing consumers) on change.
  const podcastsRef = useRef<Podcast[]>([])
  // undefined = identity still resolving (gates the boot fetch); null = anonymous.
  const [identity, setIdentity] = useState<Identity | null | undefined>(undefined)
  // Bumped on every identity transition. Async work captures the epoch it
  // started under and discards its results if the user changed underneath it —
  // a summary started as user A must never write into user B's world.
  const identityEpoch = useRef(0)

  // Union new episodes into state, keeping any existing (e.g. already-summarized) copy.
  const mergeEpisodes = useCallback((eps: Episode[]) => {
    if (!eps.length) return
    setEpisodes((prev) => {
      const m = new Map(prev.map((e) => [e.id, e]))
      for (const e of eps) if (!m.has(e.id)) m.set(e.id, e)
      return [...m.values()]
    })
  }, [])

  // Identity bootstrap: resolve the Munshot host identity once, then track
  // mid-session transitions (user switch, sign-out, late host:init). apply()
  // re-points storage scoping and the API header BEFORE setIdentity, so the
  // boot effect below always reads the right user's stores.
  useEffect(() => {
    let alive = true
    const apply = (id: Identity | null) => {
      identityEpoch.current += 1
      setStorageUser(id?.key ?? null)
      setApiUser(id?.key ?? null)
      setIdentity(id)
    }
    void resolveIdentity().then((id) => {
      if (alive) apply(id)
    })
    const off = onIdentityChange((id) => {
      if (alive) apply(id)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  useEffect(() => {
    if (identity === undefined) return // identity still resolving — the gate IS the loading state
    let alive = true
    const epoch = identityEpoch.current
    // Full reset (state AND the refs the mutation callbacks read): on a user
    // switch, nothing of the previous user may bleed into this load.
    setLoading(true)
    setPodcasts([])
    setEpisodes([])
    setWeekly(null)
    setNeedsApiKey(false)
    podcastsRef.current = []
    seedIds.current = new Set()
    summarizing.current.clear()
    Promise.all([
      api.listPodcasts(),
      api.listEpisodes(),
      api.getWeekly(),
      api.listChannels(),
      identity ? api.listProcessed() : Promise.resolve([] as Episode[]),
    ]).then(([p, e, w, roster, remoteProcessed]) => {
      // Epoch too, not just alive: an identity switch re-points storage/header
      // SYNCHRONOUSLY (apply() in the SDK message handler) while this effect's
      // cleanup only runs at React's next commit — without the epoch check, a
      // boot fetched as user A could land its mirrors/migration in user B's
      // scope during that window.
      if (!alive || identityEpoch.current !== epoch) return
      seedIds.current = new Set(p.map((x) => x.id))
      // The durable channel roster (KV via /api/channels) is the source of truth:
      // it survives deploys — the signed-in user's own roster, or the shared
      // legacy one for anonymous/standalone visits.
      const rosterById = new Map(roster.map((c) => [c.id, c]))
      // Seeds, with any stored tracked override applied (a suggestion picked in
      // Discover, or a default show the user untracked).
      const seeds = p.map((s) => {
        const o = rosterById.get(s.id)
        return o ? { ...s, tracked: !!o.tracked } : s
      })
      // User-added shows: the server roster first, then any known only to this
      // browser (saved before the backend store existed, or while it was
      // unreachable) — pushed up once so they're on every device from now on.
      // loadTracked() is user-scoped, so a signed-in first session reads an
      // empty mirror and never migrates legacy/anonymous data into the user.
      const rosterAdds = roster.filter((c) => !seedIds.current.has(c.id) && c.tracked)
      const localOnly = loadTracked().filter((tp) => !seedIds.current.has(tp.id) && !rosterById.has(tp.id))
      if (localOnly.length) void api.migrateChannels(localOnly)
      const persisted = [...rosterAdds, ...localOnly]
      mirrorTracked(persisted) // local fallback copy = what we just resolved
      const merged = [...persisted, ...seeds]
      // Locked shows have no public feed — drop any (seed) episodes for them so a
      // fabricated summary/transcript can never reach the UI. Single chokepoint:
      // Home, Episodes, Search, Weekly, and the channel selector all derive from this.
      const locked = new Set(p.filter((x) => x.locked).map((x) => x.id))
      // Re-hydrate processed history. Precedence: fresh feed ← this browser's
      // cache (user-scoped localStorage) ← the durable per-user server history,
      // which wins as the cross-device truth — except a locally cached transcript
      // is kept when the lean server copy lacks one (it re-hydrates from the
      // shared store otherwise, but keeping it is free).
      const localProcessed = loadProcessed()
      const localById = new Map(localProcessed.map((x) => [x.id, x]))
      const remoteMerged = remoteProcessed.map((ep) => {
        const local = localById.get(ep.id)
        return local?.transcript?.length && !ep.transcript?.length ? { ...ep, transcript: local.transcript } : ep
      })
      const byId = new Map<string, Episode>()
      for (const ep of e) byId.set(ep.id, ep)
      for (const ep of localProcessed) byId.set(ep.id, ep)
      for (const ep of remoteMerged) byId.set(ep.id, ep)
      if (identity) {
        const remoteIds = new Set(remoteMerged.map((x) => x.id))
        const localExtras = localProcessed.filter((x) => !remoteIds.has(x.id))
        // Local cache := the durable truth plus this browser's unpushed extras…
        mirrorProcessed([...remoteMerged, ...localExtras])
        // …and self-heal KV: an entry only the browser has means an earlier
        // POST failed (offline, transient) — push it up now.
        for (const ep of localExtras) {
          if (ep.status === 'ready' && ep.summary) void api.saveProcessedRemote(leanEpisode(ep))
        }
      }
      setPodcasts(merged)
      setEpisodes([...byId.values()].filter((ep) => !locked.has(ep.podcastId)))
      setWeekly(w)
      setLoading(false)
      // Detect each user-added feed's recent episodes (best-effort, non-blocking).
      for (const tp of persisted) {
        if (!tp.feedUrl) continue
        api.fetchFeedEpisodes(tp.feedUrl, tp.id).then((eps) => {
          if (alive && identityEpoch.current === epoch) mergeEpisodes(eps)
        })
      }
    })
    return () => {
      alive = false
    }
  }, [identity, mergeEpisodes])

  // Keep the ref in step with the latest podcasts for the stable callbacks.
  useEffect(() => {
    podcastsRef.current = podcasts
  }, [podcasts])

  // Simulated pipeline: advance any in-progress episode one stage every few
  // seconds so the processing UI genuinely moves. There is no real backend yet —
  // this is a client-side simulation. Swap it for a poll / websocket against the
  // real API and the same `status` field keeps driving the UI unchanged.
  useEffect(() => {
    if (loading) return
    const timer = setInterval(() => {
      setEpisodes((prev) => {
        // Only advance episodes that have a summary to land on — real feed
        // episodes have none yet, so they stay put (no fake "processing" churn).
        if (!prev.some((e) => e.summary && nextStatus(e.status))) return prev
        return prev.map((e) => {
          if (!e.summary) return e
          const next = nextStatus(e.status)
          return next ? { ...e, status: next } : e
        })
      })
    }, 4500)
    return () => clearInterval(timer)
  }, [loading])

  const podcastById = useCallback((id: string) => podcasts.find((p) => p.id === id), [podcasts])
  const episodeById = useCallback((id: string) => episodes.find((e) => e.id === id), [episodes])
  const episodesByPodcast = useCallback(
    (podcastId: string) => episodes.filter((e) => e.podcastId === podcastId),
    [episodes],
  )

  const toggleTracked = useCallback((id: string) => {
    const current = podcastsRef.current.find((p) => p.id === id)
    if (!current) return
    const nowTracked = !current.tracked
    setPodcasts((prev) => prev.map((p) => (p.id === id ? { ...p, tracked: nowTracked } : p)))
    // Optimistic write-through to the durable roster — seeds and adds alike, so
    // the choice survives reloads, deploys, and other browsers.
    void api.upsertChannel({ ...current, tracked: nowTracked })
    // Only user-added shows persist. Re-detect episodes when re-tracked; on untrack,
    // drop their episodes from the session so a custom feed doesn't linger on Episodes.
    if (!seedIds.current.has(id)) {
      if (nowTracked) {
        saveTracked({ ...current, tracked: true })
        if (current.feedUrl) {
          const epoch = identityEpoch.current
          api.fetchFeedEpisodes(current.feedUrl, id).then((eps) => {
            if (identityEpoch.current === epoch) mergeEpisodes(eps)
          })
        }
      } else {
        removeTracked(id)
        setEpisodes((prev) => prev.filter((e) => e.podcastId !== id))
      }
    }
  }, [mergeEpisodes])

  const addPodcast = useCallback(
    (incoming: Podcast) => {
      const epoch = identityEpoch.current
      const mergeIfSameUser = (eps: Episode[]) => {
        if (identityEpoch.current === epoch) mergeEpisodes(eps)
      }
      const entry: Podcast = { ...incoming, tracked: true }
      const match = podcastsRef.current.find((p) => samePodcast(p, entry))
      if (match) {
        // Already known (often a seed show surfaced by search) — just ensure it's tracked.
        setPodcasts((prev) => prev.map((p) => (p.id === match.id ? { ...p, tracked: true } : p)))
        void api.upsertChannel({ ...match, tracked: true })
        if (!seedIds.current.has(match.id)) {
          saveTracked({ ...match, tracked: true })
          if (match.feedUrl) api.fetchFeedEpisodes(match.feedUrl, match.id).then(mergeIfSameUser)
        }
        return
      }
      setPodcasts((prev) =>
        prev.some((p) => p.id === entry.id) ? prev.map((p) => (p.id === entry.id ? { ...p, tracked: true } : p)) : [entry, ...prev],
      )
      saveTracked(entry)
      void api.upsertChannel(entry)
      if (entry.feedUrl) api.fetchFeedEpisodes(entry.feedUrl, entry.id).then(mergeIfSameUser)
    },
    [mergeEpisodes],
  )

  const summarizeEpisode = useCallback(async (episode: Episode, podcast?: Podcast, opts?: { force?: boolean }) => {
    // Two jobs, one path — both reuse /api/summary (on a shared-store hit the
    // server returns the full result with no LLM/transcription cost):
    //  • generate — a new episode with no summary yet, or
    //  • hydrate  — a SHARED episode whose summary arrived via the feed overlay but
    //    whose (bulky) transcript wasn't included; fetch it now from the store.
    const force = !!opts?.force
    const needsSummary = !episode.summary
    const needsTranscript = !!episode.summary && !episode.transcript?.length && !!(episode.transcriptUrl || episode.audioUrl)
    // A forced refresh regenerates even an already-summarized episode (Refresh button).
    const willGenerate = needsSummary || force
    // audioUrl counts: Groq/Deepgram can transcribe it even with no notes or feed transcript.
    if (
      (!willGenerate && !needsTranscript) ||
      (!episode.notes && !episode.transcriptUrl && !episode.audioUrl) ||
      summarizing.current.has(episode.id)
    )
      return
    summarizing.current.add(episode.id)
    // A summary started under one identity must never write into another's
    // state, localStorage cache, or server history (episode ids are global, so
    // a stale write WOULD land) — if the user switched mid-flight, drop it all.
    const epoch = identityEpoch.current
    const setStatus = (status: Episode['status'], patch?: Partial<Episode>) =>
      setEpisodes((prev) => prev.map((e) => (e.id === episode.id ? { ...e, status, ...(patch ?? {}) } : e)))
    // Only show the processing pipeline when actually generating; a transcript
    // hydrate happens quietly so an already-READY shared episode never flickers.
    if (needsSummary) setStatus('summarizing')
    try {
      const { summary, transcript } = await api.generateSummary({
        id: episode.id, // the shared cache key — lets every user reuse this work
        title: episode.title,
        show: podcast?.title ?? '',
        notes: episode.notes,
        transcriptUrl: episode.transcriptUrl,
        audioUrl: episode.audioUrl,
        force, // Refresh: skip the server cache and regenerate (overwrites the shared entry)
      })
      if (identityEpoch.current !== epoch) return
      const ready: Partial<Episode> = { summary, ...(transcript?.length ? { transcript } : {}) }
      setStatus('ready', ready)
      // Persist ONLY work this session actually generated. A transcript hydrate
      // of a shared-overlay episode (processed by some OTHER user) must not
      // enter this user's history — "processed" means episodes YOU ran, and the
      // hydrate refetches free from the shared store on any later visit anyway.
      if (willGenerate) {
        // Locally so it survives a reload / redeploy (see processedStore) — and,
        // when signed in, the lean entry goes to the durable per-user history so
        // it follows the user across devices (the summary itself lives once, in
        // the global shared cache). A forced refresh overwrites the prior entry.
        const done: Episode = { ...episode, status: 'ready', ...ready }
        saveProcessed(done)
        if (getIdentity()) void api.saveProcessedRemote(leanEpisode(done))
      }
      setNeedsApiKey(false)
    } catch (err) {
      if (identityEpoch.current !== epoch) return
      if (err instanceof api.NoApiKeyError) {
        setNeedsApiKey(true)
        if (needsSummary) setStatus('detected') // not a real failure — just no key configured yet
      } else if (needsSummary) {
        setStatus('failed')
      }
      // A hydrate failure leaves the existing summary intact (status stays 'ready').
    } finally {
      // Same-epoch calls own their marker. A stale call's marker was already
      // removed by the boot reset's clear(); any marker present now belongs to
      // a NEWER call for the same (globally-shared) episode id — deleting it
      // here would let a duplicate generation slip past the dedupe check.
      if (identityEpoch.current === epoch) summarizing.current.delete(episode.id)
    }
  }, [])

  // Bulk "process this week": summarise `targets` one at a time (gentle pacing) so it
  // never hammers the API. Held here in the provider, so it KEEPS RUNNING when the
  // user navigates away — the Weekly page reads `weekProgress` and re-attaches on
  // return. De-dupes (no-op if already running) and drops out on an identity switch.
  const processWeek = useCallback(async (targets: Episode[]) => {
    if (weekRunning.current || !targets.length) return
    weekRunning.current = true
    weekCancel.current = false
    const epoch = identityEpoch.current
    setWeekProcessing(true)
    setWeekProgress({ done: 0, total: targets.length, title: '' })
    try {
      for (let i = 0; i < targets.length; i++) {
        if (weekCancel.current || identityEpoch.current !== epoch) break
        setWeekProgress({ done: i, total: targets.length, title: targets[i].title })
        const podcast = podcastsRef.current.find((p) => p.id === targets[i].podcastId)
        await summarizeEpisode(targets[i], podcast)
        if (weekCancel.current || identityEpoch.current !== epoch) break
        await new Promise((r) => setTimeout(r, 400)) // gentle pacing between episodes
      }
    } finally {
      if (identityEpoch.current === epoch) {
        setWeekProgress((p) => ({ ...p, done: p.total, title: '' }))
        setWeekProcessing(false)
      }
      weekRunning.current = false
    }
  }, [summarizeEpisode])

  const cancelProcessWeek = useCallback(() => {
    weekCancel.current = true
  }, [])

  const value = useMemo<AppData>(
    () => ({
      loading,
      podcasts,
      episodes,
      weekly,
      identity,
      needsApiKey,
      podcastById,
      episodeById,
      episodesByPodcast,
      toggleTracked,
      addPodcast,
      summarizeEpisode,
      weekProcessing,
      weekProgress,
      processWeek,
      cancelProcessWeek,
    }),
    [loading, podcasts, episodes, weekly, identity, needsApiKey, podcastById, episodeById, episodesByPodcast, toggleTracked, addPodcast, summarizeEpisode, weekProcessing, weekProgress, processWeek, cancelProcessWeek],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAppData(): AppData {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useAppData must be used within <AppDataProvider>')
  return ctx
}
