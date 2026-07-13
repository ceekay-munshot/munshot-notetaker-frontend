import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Episode, Podcast, WeeklySummary } from '../lib/types'
import type { Identity } from '../lib/munshot'
import * as api from '../lib/api'
import { decodeMeetingId } from '../lib/meetings'
import { useAuth } from './Auth'

// The provider loads every meeting the signed-in user can see (GET /api/transcripts,
// mapped onto the Episode/Podcast model in lib/meetings.ts) and exposes it to the
// app via context, alongside the notetaker features the dashboard drives directly:
// schedules, calendar sync, the join/leave bot, and on-demand AI summaries.
//
// It only ever mounts inside an authenticated session (see App.tsx), so `identity`
// is always the signed-in user.

interface AppData {
  loading: boolean
  podcasts: Podcast[]
  episodes: Episode[]
  weekly: WeeklySummary | null
  identity: Identity | null | undefined
  isAdmin: boolean
  /** True once an AI summary request came back "no key configured" (503). */
  needsApiKey: boolean
  // selectors
  podcastById: (id: string) => Podcast | undefined
  episodeById: (id: string) => Episode | undefined
  episodesByPodcast: (podcastId: string) => Episode[]
  // meetings
  refresh: () => Promise<void>
  summarizeEpisode: (episode: Episode, podcast?: Podcast, opts?: { force?: boolean }) => Promise<void>
  // notetaker bot
  sendBot: (meetingUrl: string, action?: 'join' | 'leave') => Promise<void>
  // schedules
  schedules: api.Schedule[]
  refreshSchedules: () => Promise<void>
  createSchedule: (input: api.NewSchedule) => Promise<void>
  deleteSchedule: (id: string) => Promise<void>
  // calendar
  calendarEvents: api.CalendarEvent[]
  calendarLoading: boolean
  /** True once the initial calendar load has settled (or immediately for admin,
   *  who has no calendar) — gates auto-summarize so it doesn't run before the
   *  calendar data needed to tell a named meeting from a nameless one exists. */
  calendarReady: boolean
  syncCalendar: () => Promise<{ count: number; note?: string; needsConnect: boolean }>
  refreshCalendar: () => Promise<api.CalendarEvent[]>
  removeCalendarEvent: (eventId: number | string) => Promise<void>
  removeCalendarEvents: (eventIds: (number | string)[]) => Promise<void>
  cancelledEvents: api.CalendarEvent[]
  restoreCalendarEvent: (eventId: number | string) => Promise<void>
  restoreCalendarEvents: (eventIds: (number | string)[]) => Promise<void>
  // bulk weekly processing
  weekProcessing: boolean
  weekProgress: { done: number; total: number; title: string }
  processWeek: (targets: Episode[]) => Promise<void>
  cancelProcessWeek: () => void
  // legacy podcast-era mutations — inert in the meetings build, kept for callers
  toggleTracked: (id: string) => void
  addPodcast: (podcast: Podcast) => void
}

const Ctx = createContext<AppData | null>(null)

// Normalize whatever the upstream calendar endpoint returns into a flat event list.
function normalizeCalendar(payload: any): api.CalendarEvent[] {
  if (!payload) return []
  const arr = Array.isArray(payload)
    ? payload
    : payload.calendar_events || payload.meetings || payload.events || payload.items || payload.calendar || []
  return Array.isArray(arr) ? arr : []
}

// Best-effort human note from the upstream /calendar/sync result body. The exact
// shape isn't guaranteed, so we look at the common places a message/error could
// live and surface the first non-empty string we find (kept short for the UI).
function syncNote(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined
  const r = result as Record<string, unknown>
  for (const key of ['error', 'message', 'detail', 'status', 'note']) {
    const v = r[key]
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 200)
  }
  return undefined
}

// When the calendar isn't connected yet, the upstream sync hands back an OAuth
// authorization link to send the user to. The field name isn't guaranteed, so
// check the common spellings and only accept a real http(s) URL.
function syncConnectUrl(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined
  const r = result as Record<string, unknown>
  for (const key of ['connect_url', 'connectUrl', 'authorize_url', 'auth_url', 'authUrl', 'url']) {
    const v = r[key]
    if (typeof v === 'string' && /^https?:\/\//i.test(v.trim())) return v.trim()
  }
  return undefined
}

export function AppDataProvider({ children }: { children: ReactNode }) {
  const { state } = useAuth()
  const email = state.status === 'authed' ? state.email : ''
  const isAdmin = state.status === 'authed' ? state.isAdmin : false

  const [loading, setLoading] = useState(true)
  const [podcasts, setPodcasts] = useState<Podcast[]>([])
  const [episodes, setEpisodes] = useState<Episode[]>([])
  const [weekly] = useState<WeeklySummary | null>(null)
  const [needsApiKey, setNeedsApiKey] = useState(false)
  const [schedules, setSchedules] = useState<api.Schedule[]>([])
  const [calendarEvents, setCalendarEvents] = useState<api.CalendarEvent[]>([])
  const [cancelledEvents, setCancelledEvents] = useState<api.CalendarEvent[]>([])
  const [calendarLoading, setCalendarLoading] = useState(false)
  const [calendarReady, setCalendarReady] = useState(false)
  const summarizing = useRef<Set<string>>(new Set())

  const [weekProcessing, setWeekProcessing] = useState(false)
  const [weekProgress, setWeekProgress] = useState({ done: 0, total: 0, title: '' })
  const weekCancel = useRef(false)
  const weekRunning = useRef(false)

  const identity: Identity | null = email ? { userId: email, key: email, email, name: email } : null

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const { episodes: eps, podcasts: pods } = await api.fetchMeetings()
      setEpisodes((prev) => {
        // Preserve any summary already generated this session.
        const byId = new Map(prev.map((e) => [e.id, e]))
        return eps.map((e) => {
          const old = byId.get(e.id)
          return old?.summary ? { ...e, summary: old.summary, status: old.status } : e
        })
      })
      setPodcasts(pods)
    } catch {
      // Transient/empty backend (e.g. no transcripts yet) — show an empty
      // dashboard rather than crashing; the notetaker controls still work.
      setEpisodes([])
      setPodcasts([])
    } finally {
      setLoading(false)
    }
  }, [])

  const refreshSchedules = useCallback(async () => {
    try {
      setSchedules(await api.listSchedules())
    } catch {
      /* leave the prior list on a transient failure */
    }
  }, [])

  // Returns the active (non-cancelled) events so callers (e.g. sync) can report
  // the real outcome instead of assuming success.
  const refreshCalendar = useCallback(async (): Promise<api.CalendarEvent[]> => {
    try {
      // Pull cancelled ones too, then split: active drive "Upcoming", cancelled
      // drive the "Removed" section (restore).
      const { calendar } = await api.calendarMeetings(true)
      const all = normalizeCalendar(calendar)
      const active = all.filter((e) => String(e.status) !== 'cancelled')
      setCalendarEvents(active)
      setCancelledEvents(all.filter((e) => String(e.status) === 'cancelled'))
      return active
    } catch {
      /* keep prior events */
      return calendarEvents
    }
  }, [calendarEvents])

  // Boot / re-boot whenever the signed-in user changes.
  useEffect(() => {
    if (state.status !== 'authed') return
    setCalendarReady(false)
    void refresh()
    if (!isAdmin) {
      void refreshSchedules()
      // Auto-summarize (see summarizeEpisode) must not run until this settles —
      // otherwise a named meeting can be judged nameless just because calendar
      // data hasn't arrived yet.
      void refreshCalendar().finally(() => setCalendarReady(true))
    } else {
      setCalendarReady(true) // admin accounts have no calendar to wait for
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, email, isAdmin])

  // A meeting synced from the calendar keeps the name it has THERE — only a
  // meeting with no name gets an AI-minted title. Build meeting_id -> calendar
  // name from the loaded events (active + cancelled: a meeting can be transcribed
  // after it's removed), then overlay it so the real name wins over any AI title
  // in every view, export, and email that reads the episode/podcast title.
  const calendarTitleById = useMemo(() => {
    const m = new Map<string, string>()
    for (const ev of [...calendarEvents, ...cancelledEvents]) {
      const id = ev.meeting_id != null ? String(ev.meeting_id).trim() : ''
      const name = String(ev.title || ev.summary || '').trim()
      if (id && name && name.toLowerCase() !== 'meeting' && !m.has(id)) m.set(id, name)
    }
    return m
  }, [calendarEvents, cancelledEvents])

  const applyCalendarName = useCallback(
    <T extends { id: string; title: string }>(item: T): T => {
      if (!calendarTitleById.size) return item
      const cal = calendarTitleById.get(decodeMeetingId(item.id).meetingId)
      return cal && cal !== item.title ? { ...item, title: cal } : item
    },
    [calendarTitleById],
  )

  const displayEpisodes = useMemo(() => episodes.map(applyCalendarName), [episodes, applyCalendarName])
  const displayPodcasts = useMemo(() => podcasts.map(applyCalendarName), [podcasts, applyCalendarName])

  const podcastById = useCallback((id: string) => displayPodcasts.find((p) => p.id === id), [displayPodcasts])
  const episodeById = useCallback((id: string) => displayEpisodes.find((e) => e.id === id), [displayEpisodes])
  const episodesByPodcast = useCallback(
    (podcastId: string) => displayEpisodes.filter((e) => e.podcastId === podcastId),
    [displayEpisodes],
  )

  const summarizeEpisode = useCallback(async (episode: Episode, _podcast?: Podcast, opts?: { force?: boolean }) => {
    if ((episode.summary && !opts?.force) || summarizing.current.has(episode.id)) return
    summarizing.current.add(episode.id)
    setEpisodes((prev) => prev.map((e) => (e.id === episode.id ? { ...e, status: 'summarizing' } : e)))
    // If the meeting already has a calendar name, don't let the worker mint (or
    // us apply) an AI title — the calendar name is authoritative.
    const calendarName = calendarTitleById.get(decodeMeetingId(episode.id).meetingId)
    const hasName = !!calendarName
    try {
      const { summary, title } = await api.summarizeMeeting(episode, { force: opts?.force, calendarName })
      const named = !hasName && title ? title : undefined
      setEpisodes((prev) =>
        prev.map((e) => (e.id === episode.id ? { ...e, status: 'ready', summary, title: named || e.title } : e)),
      )
      // A freshly-minted name replaces the "Meeting <id>" fallback across this
      // session (some views read the podcast title). It's already stored
      // server-side, so any reload — for any user — shows it too.
      if (named) setPodcasts((prev) => prev.map((p) => (p.id === episode.id ? { ...p, title: named } : p)))
      setNeedsApiKey(false)
    } catch (err) {
      if (err instanceof api.ApiError && err.status === 503) {
        setNeedsApiKey(true)
        setEpisodes((prev) => prev.map((e) => (e.id === episode.id ? { ...e, status: 'ready' } : e)))
      } else {
        setEpisodes((prev) => prev.map((e) => (e.id === episode.id ? { ...e, status: 'failed' } : e)))
      }
    } finally {
      summarizing.current.delete(episode.id)
    }
  }, [calendarTitleById])

  const sendBot = useCallback(async (meetingUrl: string, action: 'join' | 'leave' = 'join') => {
    await api.sendBot(meetingUrl, action)
  }, [])

  const createSchedule = useCallback(
    async (input: api.NewSchedule) => {
      const created = await api.createSchedule(input)
      // Show it immediately. Workers KV `list` is eventually consistent, so
      // re-listing right after the write often misses the new key — which made
      // freshly-created schedules "vanish" from Upcoming. Add optimistically
      // instead of relying on that immediate re-list.
      if (created && created.id) {
        setSchedules((prev) => [...prev.filter((s) => s.id !== created.id), created])
      } else {
        await refreshSchedules()
      }
    },
    [refreshSchedules],
  )

  const deleteSchedule = useCallback(
    async (id: string) => {
      setSchedules((prev) => prev.filter((s) => s.id !== id)) // optimistic
      try {
        await api.deleteSchedule(id)
      } finally {
        await refreshSchedules()
      }
    },
    [refreshSchedules],
  )

  // Runs the upstream sync, then reloads the calendar and reports what actually
  // landed. A 200 from /calendar/sync only means the request was accepted — it
  // does NOT guarantee any meetings were imported — so we return the resulting
  // count (and any note the upstream sent) rather than assuming success.
  const syncCalendar = useCallback(async (): Promise<{ count: number; note?: string; needsConnect: boolean }> => {
    setCalendarLoading(true)
    try {
      const res = await api.calendarSync()
      const events = await refreshCalendar()
      const note = syncNote(res?.result)
      // The backend signals "not connected" via a connect_url and/or a note.
      // We only need the boolean — the browser is sent through the Worker's
      // /api/calendar/connect route, never the raw backend URL.
      const needsConnect = !!syncConnectUrl(res?.result) || /not connected|authori[sz]e|connect your/i.test(note || '')
      return { count: events.length, note, needsConnect }
    } finally {
      setCalendarLoading(false)
    }
  }, [refreshCalendar])

  const removeCalendarEvent = useCallback(
    async (eventId: number | string) => {
      // optimistic: drop it from the list right away
      setCalendarEvents((prev) => prev.filter((e) => String(e.id) !== String(eventId)))
      try {
        await api.calendarRemove(eventId)
      } finally {
        await refreshCalendar()
      }
    },
    [refreshCalendar],
  )

  // Remove several occurrences at once (a whole recurring series).
  const removeCalendarEvents = useCallback(
    async (eventIds: (number | string)[]) => {
      const drop = new Set(eventIds.map(String))
      setCalendarEvents((prev) => prev.filter((e) => !drop.has(String(e.id)))) // optimistic
      try {
        await Promise.all(eventIds.map((id) => api.calendarRemove(id)))
      } finally {
        await refreshCalendar()
      }
    },
    [refreshCalendar],
  )

  const restoreCalendarEvent = useCallback(
    async (eventId: number | string) => {
      setCancelledEvents((prev) => prev.filter((e) => String(e.id) !== String(eventId))) // optimistic
      try {
        await api.calendarRestore(eventId)
      } finally {
        await refreshCalendar()
      }
    },
    [refreshCalendar],
  )

  // Restore several occurrences at once (undo a whole series).
  const restoreCalendarEvents = useCallback(
    async (eventIds: (number | string)[]) => {
      const back = new Set(eventIds.map(String))
      setCancelledEvents((prev) => prev.filter((e) => !back.has(String(e.id)))) // optimistic
      try {
        await Promise.all(eventIds.map((id) => api.calendarRestore(id)))
      } finally {
        await refreshCalendar()
      }
    },
    [refreshCalendar],
  )

  const processWeek = useCallback(
    async (targets: Episode[]) => {
      if (weekRunning.current || !targets.length) return
      weekRunning.current = true
      weekCancel.current = false
      setWeekProcessing(true)
      setWeekProgress({ done: 0, total: targets.length, title: '' })
      try {
        for (let i = 0; i < targets.length; i++) {
          if (weekCancel.current) break
          setWeekProgress({ done: i, total: targets.length, title: targets[i].title })
          await summarizeEpisode(targets[i])
          await new Promise((r) => setTimeout(r, 300))
        }
      } finally {
        setWeekProgress((p) => ({ ...p, done: p.total, title: '' }))
        setWeekProcessing(false)
        weekRunning.current = false
      }
    },
    [summarizeEpisode],
  )

  const cancelProcessWeek = useCallback(() => {
    weekCancel.current = true
  }, [])

  // Inert in the meetings build (Discover / tracking is hidden).
  const toggleTracked = useCallback(() => {}, [])
  const addPodcast = useCallback(() => {}, [])

  const value = useMemo<AppData>(
    () => ({
      loading,
      podcasts: displayPodcasts,
      episodes: displayEpisodes,
      weekly,
      identity,
      isAdmin,
      needsApiKey,
      podcastById,
      episodeById,
      episodesByPodcast,
      refresh,
      summarizeEpisode,
      sendBot,
      schedules,
      refreshSchedules,
      createSchedule,
      deleteSchedule,
      calendarEvents,
      calendarLoading,
      calendarReady,
      syncCalendar,
      refreshCalendar,
      removeCalendarEvent,
      removeCalendarEvents,
      cancelledEvents,
      restoreCalendarEvent,
      restoreCalendarEvents,
      weekProcessing,
      weekProgress,
      processWeek,
      cancelProcessWeek,
      toggleTracked,
      addPodcast,
    }),
    [
      loading,
      displayPodcasts,
      displayEpisodes,
      weekly,
      identity,
      isAdmin,
      needsApiKey,
      podcastById,
      episodeById,
      episodesByPodcast,
      refresh,
      summarizeEpisode,
      sendBot,
      schedules,
      refreshSchedules,
      createSchedule,
      deleteSchedule,
      calendarEvents,
      calendarLoading,
      calendarReady,
      syncCalendar,
      refreshCalendar,
      removeCalendarEvent,
      removeCalendarEvents,
      cancelledEvents,
      restoreCalendarEvent,
      restoreCalendarEvents,
      weekProcessing,
      weekProgress,
      processWeek,
      cancelProcessWeek,
      toggleTracked,
      addPodcast,
    ],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAppData(): AppData {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useAppData must be used within <AppDataProvider>')
  return ctx
}
