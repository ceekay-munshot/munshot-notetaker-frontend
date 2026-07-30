import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import * as api from '../lib/api'
import { encodeVideoId, isVideoPending, type VideoRecord } from '../lib/videos'
import { useAuth } from './Auth'

// The Videos tab's data layer: every YouTube video the signed-in account has
// queued (admin: every account's), loaded from GET /api/youtube.
//
// A queued video is transcribed by the backend over the following minutes, so
// the list polls itself while anything is still in flight — the Worker refreshes
// in-flight jobs on each list call, so one poll of one route keeps the whole
// tab live. Polling stops the moment everything is settled (and while the tab is
// hidden), so an idle dashboard costs nothing.

const POLL_MS = 8000

interface VideosData {
  loading: boolean
  /** True after the first load has settled — separates "empty" from "not yet loaded". */
  loaded: boolean
  videos: VideoRecord[]
  /** True when the list spans every account (the signed-in user is admin). */
  admin: boolean
  error: string | null
  videoByHandle: (handle: string) => VideoRecord | undefined
  refresh: () => Promise<void>
  /** Queue a YouTube link. Resolves with the record (existing one if already
   *  added); rejects with the server's message so the form can show it. */
  addVideo: (url: string) => Promise<VideoRecord>
  removeVideo: (video: VideoRecord) => Promise<void>
  /** Fold a fresher copy of one video (e.g. from the detail view) into the list. */
  applyVideo: (video: VideoRecord) => void
}

const Ctx = createContext<VideosData | null>(null)

export function VideosProvider({ children }: { children: ReactNode }) {
  const { state } = useAuth()
  const authed = state.status === 'authed'
  const email = authed ? state.email : ''

  const [videos, setVideos] = useState<VideoRecord[]>([])
  const [admin, setAdmin] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)

  const load = useCallback(async (opts?: { quiet?: boolean }) => {
    if (inFlight.current) return
    inFlight.current = true
    if (!opts?.quiet) setLoading(true)
    try {
      const { videos: list, admin: isAdmin } = await api.fetchVideos()
      setVideos(list)
      setAdmin(isAdmin)
      setError(null)
    } catch (err) {
      // A background poll must never wipe the list the user is looking at —
      // only a foreground load surfaces the failure.
      if (!opts?.quiet) setError((err as Error)?.message || 'Could not load your videos.')
    } finally {
      inFlight.current = false
      if (!opts?.quiet) setLoading(false)
      setLoaded(true)
    }
  }, [])

  // Boot / re-boot whenever the signed-in account changes.
  useEffect(() => {
    if (!authed) return
    setLoaded(false)
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed, email])

  const pending = useMemo(() => videos.some(isVideoPending), [videos])

  // Poll only while something is actually being transcribed, and only while the
  // tab is visible.
  useEffect(() => {
    if (!authed || !pending) return
    let timer: number | undefined
    const tick = () => {
      if (document.visibilityState === 'visible') void load({ quiet: true })
      timer = window.setTimeout(tick, POLL_MS)
    }
    timer = window.setTimeout(tick, POLL_MS)
    return () => window.clearTimeout(timer)
  }, [authed, pending, load])

  const videoByHandle = useCallback(
    (handle: string) => videos.find((v) => encodeVideoId(v.owner, v.id) === handle),
    [videos],
  )

  const applyVideo = useCallback((video: VideoRecord) => {
    setVideos((prev) => {
      const i = prev.findIndex((v) => v.id === video.id && v.owner === video.owner)
      if (i === -1) return [video, ...prev]
      const next = [...prev]
      next[i] = video
      return next
    })
  }, [])

  const addVideo = useCallback(async (url: string) => {
    const { video } = await api.addVideo(url)
    // Show it immediately — KV list is eventually consistent, so re-listing right
    // after the write can miss the new key (the same reason schedules are added
    // optimistically rather than re-listed).
    applyVideo(video)
    setError(null)
    return video
  }, [applyVideo])

  const removeVideo = useCallback(async (video: VideoRecord) => {
    setVideos((prev) => prev.filter((v) => !(v.id === video.id && v.owner === video.owner))) // optimistic
    try {
      await api.deleteVideo(video.id, video.owner)
    } finally {
      await load({ quiet: true })
    }
  }, [load])

  const value = useMemo<VideosData>(
    () => ({
      loading,
      loaded,
      videos,
      admin,
      error,
      videoByHandle,
      refresh: () => load(),
      addVideo,
      removeVideo,
      applyVideo,
    }),
    [loading, loaded, videos, admin, error, videoByHandle, load, addVideo, removeVideo, applyVideo],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useVideos(): VideosData {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useVideos must be used within <VideosProvider>')
  return ctx
}
