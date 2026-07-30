import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import * as api from '../lib/api'
import { encodeVideoId, isVideoPending, type VideoRecord } from '../lib/videos'
import { useAuth } from './Auth'

// The Videos tab's data layer: every YouTube video the signed-in account has
// queued (admin: every account's), loaded from GET /api/youtube.
//
// The Worker fetches and stores a video's captions inline, so a video is
// normally already completed by the time the POST returns. The polling below is
// the safety net for anything left in flight (a row another tab is still
// writing): it runs only while something is actually pending, and only while
// this tab is visible, so an idle dashboard costs nothing.

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
  /** Transcribe a YouTube link. Resolves with the stored record — which may
   *  already be `failed`, since transcription runs inline, so the caller must
   *  check `failed`/`error` rather than assuming success. Rejects with the
   *  server's message when the request itself is refused. */
  addVideo: (url: string) => Promise<{ video: VideoRecord; failed: boolean; error: string }>
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
  // Videos are account-scoped, and this provider stays mounted across an
  // identity switch (a host-managed session can move from one account to the
  // next without remounting the dashboard). Every load is stamped with the
  // identity it was issued for, so a response that lands after the account
  // changed is dropped instead of showing the previous account's videos.
  const identityRef = useRef(email)
  identityRef.current = email
  // Admin's list legitimately spans every account; a normal session's does not.
  const adminSessionRef = useRef(false)
  adminSessionRef.current = authed && state.isAdmin

  const load = useCallback(async (opts?: { quiet?: boolean }) => {
    const issuedFor = identityRef.current
    if (inFlight.current) return
    inFlight.current = true
    if (!opts?.quiet) setLoading(true)
    try {
      const { videos: list, admin: isAdmin } = await api.fetchVideos()
      if (identityRef.current !== issuedFor) return // the account changed mid-flight
      setVideos(list)
      setAdmin(isAdmin)
      setError(null)
    } catch (err) {
      // A background poll must never wipe the list the user is looking at —
      // only a foreground load surfaces the failure.
      if (identityRef.current !== issuedFor) return
      if (!opts?.quiet) setError((err as Error)?.message || 'Could not load your videos.')
    } finally {
      inFlight.current = false
      if (identityRef.current === issuedFor) {
        if (!opts?.quiet) setLoading(false)
        setLoaded(true)
      }
    }
  }, [])

  // Boot / re-boot whenever the signed-in account changes. The previous
  // account's videos are cleared immediately — never left on screen while the
  // new account loads — and its in-flight request is abandoned (the stamp check
  // above discards its response) so this load isn't skipped by the guard.
  useEffect(() => {
    setVideos([])
    setAdmin(false)
    setError(null)
    setLoaded(false)
    inFlight.current = false
    if (!authed) return
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
    // Never fold a record from another account into this account's list. Every
    // caller here writes after an await (add, restore-after-failed-delete, the
    // detail view's refresh), and the provider stays mounted across an identity
    // switch — so without this an in-flight response for account A could land in
    // account B's freshly-cleared list and expose A's video.
    const current = identityRef.current
    if (!adminSessionRef.current && video.owner.toLowerCase() !== current.toLowerCase()) return
    setVideos((prev) => {
      const i = prev.findIndex((v) => v.id === video.id && v.owner === video.owner)
      if (i !== -1) {
        const next = [...prev]
        next[i] = video
        return next
      }
      // New (or restored after a failed delete) — keep the server's newest-first
      // order so a row never lands in the wrong place.
      return [video, ...prev].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    })
  }, [])

  const addVideo = useCallback(async (url: string) => {
    const issuedFor = identityRef.current
    const { video, failed, error } = await api.addVideo(url)
    if (identityRef.current !== issuedFor) return { video, failed, error } // the account changed mid-flight
    // Show it immediately — KV list is eventually consistent, so re-listing right
    // after the write can miss the new key (the same reason schedules are added
    // optimistically rather than re-listed).
    applyVideo(video)
    setError(null)
    return { video, failed, error }
  }, [applyVideo])

  // Never rejects: a failed delete puts the row back and reports why, so the
  // row can't just vanish and silently reappear on the next poll.
  const removeVideo = useCallback(async (video: VideoRecord) => {
    const issuedFor = identityRef.current
    setVideos((prev) => prev.filter((v) => !(v.id === video.id && v.owner === video.owner))) // optimistic
    try {
      await api.deleteVideo(video.id, video.owner)
      if (identityRef.current !== issuedFor) return // the account changed mid-flight
      setError(null)
      await load({ quiet: true })
    } catch (err) {
      if (identityRef.current !== issuedFor) return
      applyVideo(video) // put it back where it was
      setError((err as Error)?.message || 'Could not remove that video.')
    }
  }, [load, applyVideo])

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
