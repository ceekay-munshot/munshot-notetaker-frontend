import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useVideos } from '../store/Videos'
import { ApiError, chatVideo, fetchVideo, summarizeVideo } from '../lib/api'
import { formatDuration, longDate } from '../lib/format'
import { downloadSummary } from '../lib/exportSummary'
import { downloadSummaryPdf } from '../lib/pdfRender'
import {
  decodeVideoId,
  isVideoPending,
  parseStamp,
  parseVideoTranscript,
  videoDuration,
  videoProcessingStatus,
  videoThumbnail,
  videoTitle,
  videoToEpisode,
  videoWatchUrl,
  segmentsFromStored,
  type StoredSegment,
  type VideoRecord,
} from '../lib/videos'
import type { Summary, TranscriptSegment } from '../lib/types'
import { Icon } from '../components/Icon'
import { StatusBadge } from '../components/StatusBadge'
import { DownloadMenu } from '../components/DownloadMenu'
import { ChatAnswer, SummaryBody } from '../components/SummaryBody'

type Tab = 'summary' | 'transcript' | 'chat'

// While a video is still being transcribed the detail view polls for it, the
// same cadence the list uses.
const POLL_MS = 8000

export default function VideoDetail() {
  const { id: handle } = useParams<{ id: string }>()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { videoByHandle, applyVideo, removeVideo } = useVideos()

  const ref = useMemo(() => decodeVideoId(handle || ''), [handle])
  // The list's copy renders instantly on a click-through; the detail fetch (which
  // also carries the transcript) refines it.
  const [video, setVideo] = useState<VideoRecord | undefined>(() => (handle ? videoByHandle(handle) : undefined))
  const [stored, setStored] = useState<StoredSegment[]>([])
  const [transcriptText, setTranscriptText] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const [summary, setSummary] = useState<Summary | undefined>(undefined)
  const [summarizing, setSummarizing] = useState(false)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const summarized = useRef<string>('') // handle we've already asked to summarize

  const raw = params.get('tab')
  const [tab, setTab] = useState<Tab>((raw as Tab) || 'summary')
  useEffect(() => {
    setTab((raw as Tab) || 'summary')
  }, [handle, raw])

  const load = useCallback(async () => {
    if (!ref.id) return
    try {
      const data = await fetchVideo(ref.id, ref.owner || undefined)
      setVideo(data.video)
      applyVideo(data.video)
      setStored(data.segments)
      setTranscriptText(data.transcript)
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof ApiError && err.status === 404 ? 'not_found' : (err as Error)?.message || 'Could not load that video.')
    } finally {
      setLoading(false)
    }
  }, [ref.id, ref.owner, applyVideo])

  useEffect(() => {
    setLoading(true)
    setSummary(undefined)
    setSummaryError(null)
    setStored([])
    setTranscriptText('')
    summarized.current = ''
    void load()
  }, [load])

  // Keep polling while the backend is still working on this video.
  const pending = !!video && isVideoPending(video)
  useEffect(() => {
    if (!pending) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [pending, load])

  // The Worker stores real per-line timings, so use those; parsing the flat text
  // is only the fallback for a transcript stored before segments were returned.
  const segments = useMemo(
    () => (stored.length ? segmentsFromStored(stored) : parseVideoTranscript(transcriptText)),
    [stored, transcriptText],
  )

  const runSummary = useCallback(
    async (opts?: { force?: boolean }) => {
      if (!video || summarizing) return
      setSummarizing(true)
      setSummaryError(null)
      try {
        const res = await summarizeVideo({ id: video.id, owner: video.owner }, opts)
        setSummary(res.summary)
        // A freshly-minted name replaces the "Video <id>" fallback everywhere.
        if (res.title && res.title !== video.title) {
          const named = { ...video, title: res.title }
          setVideo(named)
          applyVideo(named)
        }
      } catch (err) {
        setSummaryError(
          err instanceof ApiError && err.status === 503
            ? 'The assistant isn’t configured yet — set the OPENAI_API_KEY secret on the Worker.'
            : (err as Error)?.message || 'The summary could not be generated just now.',
        )
      } finally {
        setSummarizing(false)
      }
    },
    [video, summarizing, applyVideo],
  )

  // Summarize once, as soon as the transcript exists (idempotent per video — the
  // Worker caches the result, so a revisit costs nothing).
  useEffect(() => {
    if (!video || !handle) return
    if (video.status !== 'completed' || !segments.length) return
    if (summary || summarized.current === handle) return
    summarized.current = handle
    void runSummary()
  }, [video, handle, segments.length, summary, runSummary])

  if (loadError === 'not_found' || (!loading && !video)) {
    return (
      <div className="grid place-items-center py-[20vh] text-center">
        <Icon name="error" size={36} className="mb-sm text-outline" />
        <p className="text-body-md text-secondary">That video could not be found.</p>
        <Link to="/videos" className="mt-sm text-metadata font-semibold text-primary hover:underline">
          Back to videos
        </Link>
      </div>
    )
  }

  if (!video) {
    return (
      <div className="grid place-items-center py-[20vh] text-secondary">
        <Icon name="progress_activity" size={32} className="mb-sm motion-safe:animate-spin text-primary" />
        <p className="text-metadata">Loading video…</p>
      </div>
    )
  }

  const title = videoTitle(video)
  const watchUrl = videoWatchUrl(video)
  const { episode, podcast } = videoToEpisode(video, segments, summary)
  const TABS: { id: Tab; label: string; show: boolean }[] = [
    { id: 'summary', label: 'Summary', show: true },
    { id: 'transcript', label: 'Transcript', show: true },
    { id: 'chat', label: 'Chat', show: !!segments.length },
  ]

  return (
    <div className="animate-fade-up">
      <button
        onClick={() => navigate(-1)}
        className="mb-md inline-flex items-center gap-1 text-metadata font-semibold text-primary transition-colors hover:underline"
      >
        <Icon name="arrow_back" size={16} /> Back to Videos
      </button>

      {/* Header */}
      <div className="mb-lg flex flex-col gap-md sm:flex-row sm:items-start">
        <a
          href={watchUrl || undefined}
          target="_blank"
          rel="noopener noreferrer"
          title="Watch on YouTube"
          className="group relative h-[104px] w-[184px] shrink-0 overflow-hidden rounded-xl bg-surface-container"
        >
          {video.videoId ? (
            <img src={videoThumbnail(video.videoId)} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="grid h-full w-full place-items-center text-outline">
              <Icon name="smart_display" size={30} />
            </span>
          )}
          <span className="absolute inset-0 grid place-items-center bg-inverse-surface/25 opacity-0 transition-opacity group-hover:opacity-100">
            <Icon name="play_circle" size={40} className="text-white" fill />
          </span>
        </a>
        <div className="flex-1">
          <h1 className="mb-2 text-display-lg tracking-tight text-on-surface">{title}</h1>
          <div className="flex flex-wrap items-center gap-3 text-metadata text-secondary">
            {video.channel && (
              <span className="inline-flex items-center gap-1">
                <Icon name="account_circle" size={15} /> {video.channel}
              </span>
            )}
            <span className="inline-flex items-center gap-1">
              <Icon name="calendar_today" size={15} /> {longDate(new Date(video.createdAt).toISOString())}
            </span>
            {videoDuration(video, segments) > 0 && (
              <span className="inline-flex items-center gap-1">
                <Icon name="schedule" size={15} /> {formatDuration(videoDuration(video, segments))}
              </span>
            )}
            <StatusBadge status={videoProcessingStatus(video.status)} />
            {watchUrl && (
              <a
                href={watchUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-semibold text-primary hover:underline"
              >
                <Icon name="open_in_new" size={15} /> Watch on YouTube
              </a>
            )}
          </div>
          <p className="mt-1.5 text-metadata text-secondary">Owned by {video.owner}</p>
        </div>
        <div className="flex items-center gap-2.5">
          {summary && (
            <button
              onClick={() => void runSummary({ force: true })}
              disabled={summarizing}
              title="Regenerate this summary from scratch (skips the cache)"
              className="press inline-flex items-center gap-2 rounded-lg border border-outline-variant bg-surface px-3 py-2.5 text-metadata font-semibold text-on-surface hover:bg-surface-container-low disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Icon name="refresh" size={18} className={summarizing ? 'motion-safe:animate-spin' : ''} />
              <span className="hidden sm:inline">{summarizing ? 'Refreshing…' : 'Refresh'}</span>
            </button>
          )}
          <DownloadMenu
            disabled={!summary}
            onPdf={() => void downloadSummaryPdf(episode, podcast)}
            onWord={() => void downloadSummary(episode, podcast)}
          />
        </div>
      </div>

      {video.status === 'failed' ? (
        <FailedPanel
          video={video}
          onRemove={async () => {
            await removeVideo(video)
            navigate('/videos')
          }}
        />
      ) : pending ? (
        <PendingPanel video={video} />
      ) : (
        <>
          <div className="mb-lg flex gap-lg overflow-x-auto border-b border-outline-variant">
            {TABS.filter((t) => t.show).map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`-mb-px whitespace-nowrap border-b-2 pb-2.5 text-[14px] transition-colors ${
                  tab === t.id ? 'border-primary font-semibold text-primary' : 'border-transparent text-secondary hover:text-on-surface'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'summary' && (
            <SummaryTab
              summary={summary}
              busy={summarizing}
              error={summaryError}
              hasTranscript={!!segments.length}
              onRetry={() => void runSummary()}
            />
          )}
          {tab === 'transcript' && <TranscriptTab segments={segments} watchUrl={watchUrl} />}
          {tab === 'chat' && <ChatTab video={video} title={title} />}
        </>
      )}
    </div>
  )
}

// ── Summary tab ───────────────────────────────────────────────────────────────
function SummaryTab({
  summary,
  busy,
  error,
  hasTranscript,
  onRetry,
}: {
  summary?: Summary
  busy: boolean
  error: string | null
  hasTranscript: boolean
  onRetry: () => void
}) {
  if (summary) {
    return (
      <section className="mx-auto max-w-reading rounded-2xl border border-outline-variant bg-surface-container-lowest p-lg shadow-card">
        <SummaryBody blocks={summary.synthesis} terms={[]} />
      </section>
    )
  }
  if (!hasTranscript) {
    return (
      <div className="grid place-items-center gap-sm rounded-2xl border border-dashed border-outline-variant bg-surface-container-low py-xl text-center">
        <Icon name="description" size={32} className="text-outline" />
        <h3 className="text-[19px] font-semibold text-on-surface-variant">No transcript to summarize</h3>
        <p className="max-w-md text-body-md text-secondary">
          The backend finished this video but returned no transcript text — it may have no spoken audio or no captions.
        </p>
      </div>
    )
  }
  return (
    <div className="grid place-items-center gap-sm rounded-2xl border border-outline-variant bg-surface-container-lowest py-xl text-center shadow-card">
      {busy ? (
        <>
          <Icon name="auto_awesome" size={32} className="text-primary motion-safe:animate-pulse" fill />
          <h3 className="text-[19px] font-semibold text-on-surface">Reading the transcript…</h3>
          <p className="max-w-md text-body-md text-secondary">
            Writing the overview, the topic-by-topic walk-through, and the takeaways. This takes a few seconds.
          </p>
        </>
      ) : (
        <>
          <Icon name={error ? 'error' : 'auto_awesome'} size={32} className={error ? 'text-error' : 'text-primary'} />
          <h3 className="text-[19px] font-semibold text-on-surface">{error ? 'Summary unavailable' : 'Summarize this video'}</h3>
          <p className="max-w-md text-body-md text-secondary">{error || 'Generate the one-page brief from the transcript.'}</p>
          <button
            onClick={onRetry}
            className="press mt-1 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-metadata font-semibold text-on-primary hover:bg-primary-container"
          >
            <Icon name="auto_awesome" size={18} /> {error ? 'Try again' : 'Generate summary'}
          </button>
        </>
      )}
    </div>
  )
}

// ── Transcript tab ────────────────────────────────────────────────────────────
function TranscriptTab({ segments, watchUrl }: { segments: TranscriptSegment[]; watchUrl: string }) {
  const [q, setQ] = useState('')
  const [copied, setCopied] = useState(false)

  if (!segments.length) {
    return (
      <div className="grid place-items-center gap-sm rounded-2xl border border-dashed border-outline-variant bg-surface-container-low py-xl text-center">
        <Icon name="graphic_eq" size={32} className="text-outline" />
        <h3 className="text-[19px] font-semibold text-on-surface-variant">No transcript yet</h3>
        <p className="max-w-md text-body-md text-secondary">
          Once the backend finishes transcribing this video, the full transcript appears here.
        </p>
      </div>
    )
  }

  const needle = q.trim().toLowerCase()
  const visible = needle ? segments.filter((s) => s.text.toLowerCase().includes(needle)) : segments

  async function copyAll() {
    const text = segments.map((s) => (s.timestamp === '—' ? s.text : `[${s.timestamp}] ${s.text}`)).join('\n\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      /* clipboard blocked — nothing to report */
    }
  }

  // A timestamp deep-links into the video at that second, so a passage can be
  // checked against the source in one click.
  function seekUrl(stamp: string): string | undefined {
    if (!watchUrl) return undefined
    const sec = parseStamp(stamp)
    if (sec == null) return watchUrl
    try {
      const u = new URL(watchUrl)
      u.searchParams.set('t', `${sec}s`)
      return u.toString()
    } catch {
      return watchUrl
    }
  }

  return (
    <section className="mx-auto max-w-reading">
      <div className="mb-md flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Icon name="search" size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-outline" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search this transcript…"
            className="w-full rounded-lg border border-outline-variant bg-surface-container-lowest py-2.5 pl-11 pr-sm text-[14px] outline-none focus:border-primary"
          />
        </div>
        <button
          onClick={() => void copyAll()}
          className="press inline-flex items-center gap-2 rounded-lg border border-outline-variant bg-surface px-3 py-2.5 text-metadata font-semibold text-on-surface hover:bg-surface-container-low"
        >
          <Icon name={copied ? 'check' : 'content_copy'} size={17} className={copied ? 'text-success' : ''} />
          {copied ? 'Copied' : 'Copy all'}
        </button>
      </div>

      <div className="overflow-hidden rounded-2xl border border-outline-variant bg-surface-container-lowest shadow-card">
        {visible.map((s) => {
          const href = seekUrl(s.timestamp)
          return (
            <div key={s.id} className="flex gap-3 border-b border-outline-variant px-md py-3.5 last:border-b-0">
              {href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open the video at this moment"
                  className="mt-0.5 shrink-0 font-mono text-[12px] font-semibold text-primary hover:underline"
                >
                  {s.timestamp}
                </a>
              ) : (
                <span className="mt-0.5 shrink-0 font-mono text-[12px] text-outline">{s.timestamp}</span>
              )}
              <p className="min-w-0 text-body-md leading-relaxed text-on-surface-variant">{s.text}</p>
            </div>
          )
        })}
        {visible.length === 0 && (
          <p className="px-md py-lg text-center text-body-md text-secondary">Nothing in this transcript matches “{q.trim()}”.</p>
        )}
      </div>
    </section>
  )
}

// ── Chat tab — free-form Q&A over this video's transcript ─────────────────────
// The Worker loads the (length-bounded) transcript server-side and answers with
// OpenAI, so even a three-hour video stays a tiny request from the browser. The
// conversation is per-visit, exactly like the meeting assistant.
type ChatMsg = { role: 'user' | 'assistant'; content: string }

const CHAT_SUGGESTIONS = [
  'Give me the key points',
  'What claims does it make, and what backs them?',
  'Any numbers or data mentioned?',
  'What should I take away from this?',
]

function ChatTab({ video, title }: { video: VideoRecord; title: string }) {
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, busy])

  async function send(text: string) {
    const q = text.trim()
    if (!q || busy) return
    const next: ChatMsg[] = [...messages, { role: 'user', content: q }]
    setMessages(next)
    setInput('')
    setError(null)
    setBusy(true)
    if (inputRef.current) inputRef.current.style.height = 'auto'
    try {
      const reply = await chatVideo({ id: video.id, owner: video.owner }, next)
      setMessages((m) => [...m, { role: 'assistant', content: reply.trim() || '(No answer.)' }])
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 503
          ? 'The assistant isn’t configured yet — set the OPENAI_API_KEY secret on the Worker.'
          : (err as Error)?.message || 'The assistant could not answer just now. Please try again.',
      )
    } finally {
      setBusy(false)
      inputRef.current?.focus()
    }
  }

  function onInput(e: ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

  return (
    <section className="mx-auto max-w-reading">
      <div className="flex h-[60vh] min-h-[440px] flex-col overflow-hidden rounded-2xl border border-outline-variant bg-surface-container-lowest shadow-card">
        {/* Header */}
        <div className="flex items-center gap-2.5 border-b border-outline-variant px-md py-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg chip-signal">
            <Icon name="smart_display" size={18} className="text-primary" fill />
          </span>
          <div className="min-w-0">
            <h2 className="text-[16px] font-semibold text-on-surface">Chat with this video</h2>
            <p className="truncate text-metadata text-secondary">Answers come only from the transcript of “{title}”.</p>
          </div>
          {messages.length > 0 && (
            <button
              onClick={() => {
                setMessages([])
                setError(null)
              }}
              className="press ml-auto inline-flex items-center gap-1.5 rounded-lg border border-outline-variant bg-surface px-2.5 py-1.5 text-metadata font-semibold text-on-surface hover:bg-surface-container-low"
            >
              <Icon name="restart_alt" size={16} /> <span className="hidden sm:inline">New chat</span>
            </button>
          )}
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-md py-md">
          {messages.length === 0 && !busy && !error ? (
            <div className="grid h-full place-items-center">
              <div className="max-w-md text-center">
                <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full chip-signal">
                  <Icon name="smart_display" size={24} className="text-primary" fill />
                </span>
                <h3 className="text-[16px] font-semibold text-on-surface">Ask about this video</h3>
                <p className="mt-1 text-body-md text-secondary">
                  Claims, numbers, who said what — I’ll answer from what the transcript covers.
                </p>
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  {CHAT_SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => void send(s)}
                      className="press rounded-full border border-outline-variant bg-surface px-3 py-1.5 text-[13px] font-medium text-on-surface hover:border-primary hover:text-primary"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            messages.map((m, i) =>
              m.role === 'user' ? (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-[14px] leading-relaxed text-on-primary">
                    {m.content}
                  </div>
                </div>
              ) : (
                <div key={i} className="flex gap-2.5">
                  <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full chip-signal">
                    <Icon name="auto_awesome" size={16} className="text-primary" fill />
                  </span>
                  <div className="min-w-0 max-w-[85%] rounded-2xl rounded-tl-md border border-outline-variant bg-surface px-3.5 py-2.5">
                    <ChatAnswer text={m.content} terms={[]} />
                  </div>
                </div>
              ),
            )
          )}

          {busy && (
            <div className="flex gap-2.5">
              <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full chip-signal">
                <Icon name="auto_awesome" size={16} className="text-primary" fill />
              </span>
              <div className="flex items-center gap-1 rounded-2xl rounded-tl-md border border-outline-variant bg-surface px-4 py-3.5">
                <span className="h-1.5 w-1.5 rounded-full bg-secondary motion-safe:animate-bounce [animation-delay:-0.2s]" />
                <span className="h-1.5 w-1.5 rounded-full bg-secondary motion-safe:animate-bounce [animation-delay:-0.1s]" />
                <span className="h-1.5 w-1.5 rounded-full bg-secondary motion-safe:animate-bounce" />
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-error/30 bg-error-container/40 px-3 py-2.5 text-[13px] text-error">
              <Icon name="error" size={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="border-t border-outline-variant p-3">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void send(input)
            }}
            className="flex items-end gap-2"
          >
            <textarea
              ref={inputRef}
              value={input}
              onChange={onInput}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send(input)
                }
              }}
              rows={1}
              placeholder="Ask about this video…"
              className="max-h-40 flex-1 resize-none rounded-xl border border-outline-variant bg-surface-container-low px-3.5 py-2.5 text-[14px] leading-relaxed outline-none focus:border-primary focus:bg-surface"
            />
            <button
              type="submit"
              disabled={!input.trim() || busy}
              aria-label="Send"
              className="press grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary text-on-primary transition-opacity hover:bg-primary-container disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Icon name={busy ? 'progress_activity' : 'send'} size={20} className={busy ? 'motion-safe:animate-spin' : ''} />
            </button>
          </form>
          <p className="mt-1.5 px-1 text-[11px] text-secondary">Enter to send · Shift + Enter for a new line</p>
        </div>
      </div>
    </section>
  )
}

// ── Still transcribing / failed ───────────────────────────────────────────────
function PendingPanel({ video }: { video: VideoRecord }) {
  return (
    <div className="grid place-items-center gap-sm rounded-2xl border border-outline-variant bg-surface-container-lowest py-xl text-center shadow-card">
      <Icon name="graphic_eq" size={34} className="text-primary motion-safe:animate-pulse" />
      <h3 className="text-[19px] font-semibold text-on-surface">
        {video.status === 'queued' ? 'Queued for transcription' : 'Transcribing this video'}
      </h3>
      <p className="max-w-md text-body-md text-secondary">
        The backend is pulling the audio and writing the transcript. This page refreshes itself — the transcript,
        summary and chat unlock as soon as it lands.
      </p>
    </div>
  )
}

function FailedPanel({ video, onRemove }: { video: VideoRecord; onRemove: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  return (
    <div className="grid place-items-center gap-sm rounded-2xl border border-error/30 bg-error-container/30 py-xl text-center">
      <Icon name="error" size={34} className="text-error" />
      <h3 className="text-[19px] font-semibold text-on-surface">This video couldn’t be transcribed</h3>
      <p className="max-w-md text-body-md text-secondary">
        {video.error || 'The transcription service could not process this video.'}
      </p>
      <button
        onClick={async () => {
          setBusy(true)
          try {
            await onRemove()
          } finally {
            setBusy(false)
          }
        }}
        disabled={busy}
        className="press mt-1 inline-flex items-center gap-2 rounded-lg border border-outline-variant bg-surface px-4 py-2.5 text-metadata font-semibold text-on-surface hover:bg-surface-container-low disabled:opacity-50"
      >
        <Icon name="delete" size={18} /> Remove from my videos
      </button>
    </div>
  )
}
