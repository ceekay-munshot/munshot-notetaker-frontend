import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAppData } from '../store/AppData'
import { useSentiment } from '../store/Sentiment'
import { downloadWeekly } from '../lib/exportWeekly'
import { downloadWeeklyPdf } from '../lib/pdfRender'
import { emailWeeklyEdition, meetingRefs, registerWeeklyRecipient, unregisterWeeklyRecipient } from '../lib/api'
import { generateWeekly, peekWeekly, pendingWeekly } from '../lib/weeklyApi'
import { listEditions } from '../lib/weeklyEditions'
import { weeklyToneView } from '../lib/tone'
import type { WeeklySummary } from '../lib/types'
import { Icon } from '../components/Icon'
import { DownloadMenu } from '../components/DownloadMenu'
import { readSubscribedEmail } from '../components/WeeklySubscribe'
import { loadRecipients, addRecipient, removeRecipient } from '../lib/recipientsStore'
import { EditionSwitcher } from '../components/EditionSwitcher'
import { RichText, entityTerms } from '../components/RichText'
import { ToneMeter } from '../components/ToneMeter'
import { WeeklyPeople } from '../components/WeeklyPeople'
import { WeeklyChat } from '../components/WeeklyChat'

const THEME_STYLES = [
  { tile: 'bg-[#eff5ff] text-[#2563eb] border-[#dbeafe]', icon: 'cloud' },
  { tile: 'bg-[#ecfdf3] text-[#15803d] border-[#d1fadf]', icon: 'pie_chart' },
  { tile: 'bg-[#f5f3ff] text-[#7c3aed] border-[#e9e2ff]', icon: 'shield' },
  { tile: 'bg-[#fff4ec] text-[#c2410c] border-[#ffe5d3]', icon: 'memory' },
  { tile: 'bg-[#fefce8] text-[#a16207] border-[#fdf0bf]', icon: 'bolt' },
]

export default function Weekly() {
  const { episodes, podcasts, episodeById, podcastById, loading, identity, needsApiKey, weekProcessing, weekProgress, processWeek, cancelProcessWeek, hydrateCachedSummaries } = useAppData()
  const { on: sentimentOn } = useSentiment()
  const [params, setParams] = useSearchParams()
  const [weekly, setWeekly] = useState<WeeklySummary | null | undefined>(undefined) // undefined = generating
  const [chatOpen, setChatOpen] = useState(false)

  // Pull in summaries the auto-summary cron (or prior opens) already produced, so
  // the weekly populates from the real content without opening each meeting first.
  // Idempotent + guarded inside AppData, so it's safe to re-run as meetings load.
  useEffect(() => {
    void hydrateCachedSummaries()
  }, [hydrateCachedSummaries])

  // Where "Email this edition" sends: the signed-in user's address, or the one
  // they subscribed the weekly brief with. Absent → the menu item is hidden.
  const userEmail = identity?.email || readSubscribedEmail()

  // Extra recipients (besides the user) the edition goes to — typed in the Download
  // menu and saved locally, per user. Each is ALSO put on the durable Monday-digest
  // list, so anyone the user adds (e.g. their boss) receives the automated weekly,
  // not just an on-demand send. The local list mirrors the chips for instant
  // re-render; the store is the source of truth, the subscriber list the sink.
  const [extraRecipients, setExtraRecipients] = useState<string[]>([])
  useEffect(() => {
    const saved = loadRecipients()
    setExtraRecipients(saved)
    // Migration / self-heal: make sure every saved recipient is on the digest list
    // (covers addresses saved before this wiring, and any earlier missed write).
    for (const addr of saved) void registerWeeklyRecipient(addr)
  }, [userEmail])
  const addExtraRecipient = (addr: string) => {
    const res = addRecipient(addr)
    setExtraRecipients(res.list)
    if (res.ok) void registerWeeklyRecipient(addr) // also subscribe to the Monday digest
    return { ok: res.ok, message: res.message }
  }
  const removeExtraRecipient = (addr: string) => {
    setExtraRecipients(removeRecipient(addr))
    void unregisterWeeklyRecipient(addr) // stop the Monday digest for this address
  }

  // The history: ready episodes sliced into per-week editions (newest first).
  const editions = useMemo(() => listEditions(episodes, podcastById), [episodes, podcastById])

  // Selected edition: ?week=<key> | 'all', defaulting to the latest week.
  const requested = params.get('week')
  const currentKey =
    requested === 'all' || (requested && editions.some((e) => e.weekKey === requested))
      ? requested
      : editions[0]?.weekKey ?? 'all'
  const selected = currentKey === 'all' ? null : editions.find((e) => e.weekKey === currentKey)

  // The episodes feeding the selected edition (a single week, or everything).
  const editionEpisodes = useMemo(() => {
    const isReady = (e: (typeof episodes)[number]) => e.status === 'ready' && e.summary
    if (currentKey === 'all') return episodes.filter(isReady)
    const ids = new Set(selected?.episodeIds ?? [])
    return episodes.filter((e) => ids.has(e.id))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episodes, currentKey, selected?.weekKey])

  // The active scope, so an in-flight (re)generation never applies its result to an
  // edition the user has since switched away from.
  const scopeRef = useRef(currentKey)
  scopeRef.current = currentKey
  const hasEpisodes = editionEpisodes.length > 0
  const [refreshing, setRefreshing] = useState(false)

  // Meeting handles for the "Ask about this week" chat — the edition's analysed
  // meetings, numbered so the server can cite them and answer across the week.
  const chatMeetings = useMemo(() => meetingRefs(editionEpisodes), [editionEpisodes])
  const chatRange = currentKey === 'all' ? 'All meetings' : selected?.rangeLabel ?? weekly?.rangeLabel

  // Load the SAVED edition for this scope (instant, no reprocess). Generate only when
  // there's nothing saved yet (first time for this scope). Re-runs on edition switch
  // and once episodes first arrive — NOT every time a new episode is detected, so a
  // busy feed never silently re-runs the synthesis.
  useEffect(() => {
    let alive = true
    const token = currentKey
    // A synthesis for this scope may still be running (e.g. started before the user
    // left the tab) — re-attach to it and show it running, rather than the stale
    // saved edition. (Must come BEFORE the cache peek.)
    const pending = pendingWeekly(currentKey)
    if (pending) {
      setRefreshing(true)
      setWeekly(undefined)
      pending
        .then((w) => alive && scopeRef.current === token && setWeekly(w))
        .catch(() => alive && scopeRef.current === token && setWeekly(null))
        .finally(() => alive && scopeRef.current === token && setRefreshing(false))
      return () => {
        alive = false
      }
    }
    const saved = peekWeekly(currentKey)
    if (saved) {
      setWeekly(saved)
      return
    }
    if (!hasEpisodes) {
      setWeekly(null)
      return
    }
    setWeekly(undefined)
    generateWeekly(editionEpisodes, podcastById, { scope: currentKey, rangeLabel: selected?.rangeLabel })
      .then((w) => alive && scopeRef.current === token && setWeekly(w))
      .catch(() => alive && scopeRef.current === token && setWeekly(null))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey, hasEpisodes])

  // Ready episodes in this edition that the SAVED edition didn't include — i.e. new
  // episodes detected since it was generated. Drives the "new episodes" banner; only
  // a Refresh folds them in.
  const newEpisodes = useMemo(() => {
    if (!weekly) return [] as typeof editionEpisodes
    const saved = new Set(weekly.sourceEpisodeIds)
    return editionEpisodes.filter((e) => e.status === 'ready' && e.summary && !saved.has(e.id))
  }, [weekly, editionEpisodes])

  // Force-regenerate the current edition from the latest episodes, overwriting the
  // saved one. The only path that folds in newly detected episodes (or a new format).
  async function refresh() {
    if (!hasEpisodes || refreshing) return
    const token = currentKey
    setRefreshing(true)
    setWeekly(undefined)
    try {
      const w = await generateWeekly(editionEpisodes, podcastById, {
        scope: currentKey,
        rangeLabel: selected?.rangeLabel,
        force: true,
      })
      if (scopeRef.current === token) setWeekly(w)
    } catch {
      if (scopeRef.current === token) setWeekly(null)
    } finally {
      setRefreshing(false)
    }
  }

  // ── "Process this week" — summarise every not-yet-processed episode from the last
  //    7 days (across the tracked podcasts) so the Monday brief includes everything.
  //    Sequential + paced, so it never hammers the API; cancellable.
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000
  const unprocessed = useMemo(() => {
    const cutoff = Date.now() - WEEK_MS
    // A meeting is "not processed" when it has content to summarise but no summary
    // yet. Meetings arrive as status:'ready' (a transcript exists) with no summary
    // until one is generated, so gate on "has a transcript / source + no summary",
    // not on a non-ready status (which only fits the podcast-era ingest lifecycle).
    return episodes.filter(
      (e) =>
        +new Date(e.publishedAt) >= cutoff &&
        e.status !== 'summarizing' &&
        !e.summary &&
        (!!(e.transcript && e.transcript.length) || !!e.transcriptUrl || !!e.audioUrl || !!(e.notes && e.notes.trim())),
    )
  }, [episodes])
  // The bulk job itself lives in AppData (so it survives navigation); the page just
  // kicks it off with this week's targets. Newly-ready episodes then surface via the
  // "new episodes" banner → Refresh folds them in, ready to email.
  const processAll = () => {
    if (weekProcessing || !unprocessed.length || needsApiKey) return
    void processWeek([...unprocessed])
  }

  function selectEdition(key: string) {
    const next = new URLSearchParams(params)
    if (key === (editions[0]?.weekKey ?? 'all')) next.delete('week') // latest → clean URL
    else next.set('week', key)
    setParams(next)
  }

  return (
    <div className="animate-fade-up">
      {/* Header */}
      <div className="mb-lg flex flex-wrap items-start justify-between gap-md">
        <div>
          <h1 className="text-display-lg tracking-tight text-on-surface">Weekly Summary</h1>
          <p className="mt-1 text-body-md text-secondary">
            {loading || weekly === undefined
              ? 'Synthesising this edition…'
              : weekly
                ? `${weekly.episodeCount} meeting${weekly.episodeCount === 1 ? '' : 's'} · ${weekly.readMinutes} min read`
                : 'No meetings analysed yet'}
          </p>
          {weekly && sentimentOn && (
            <div className="mt-2 flex items-center gap-2 text-metadata text-secondary">
              <span className="font-medium">This edition's tone</span>
              <ToneMeter tone={weeklyToneView(weekly, episodeById)} />
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          {editions.length > 0 && <EditionSwitcher editions={editions} currentKey={currentKey} onSelect={selectEdition} />}
          {editionEpisodes.length > 0 && (
            <button
              onClick={() => setChatOpen(true)}
              title="Ask questions across this week's meetings"
              className="press inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2.5 text-metadata font-semibold text-on-primary hover:bg-primary-container"
            >
              <Icon name="forum" size={18} fill />
              <span className="hidden sm:inline">Ask about this week</span>
              <span className="sm:hidden">Ask</span>
            </button>
          )}
          {editionEpisodes.length > 0 && (
            <button
              onClick={refresh}
              disabled={refreshing || weekly === undefined}
              title={newEpisodes.length ? `Refresh to fold in ${newEpisodes.length} newly detected meeting${newEpisodes.length === 1 ? '' : 's'}` : 'Regenerate this edition from the latest meetings (skips the cache)'}
              className="press relative inline-flex items-center gap-2 rounded-lg border border-outline-variant bg-surface px-3 py-2.5 text-metadata font-semibold text-on-surface hover:bg-surface-container-low disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Icon name="refresh" size={18} className={refreshing ? 'motion-safe:animate-spin' : ''} />
              <span className="hidden sm:inline">{refreshing ? 'Refreshing…' : 'Refresh'}</span>
              {newEpisodes.length > 0 && !refreshing && (
                <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-primary ring-2 ring-surface" aria-hidden />
              )}
            </button>
          )}
          {weekly && (
            <DownloadMenu
              onPdf={() => void downloadWeeklyPdf(weekly, episodeById, podcastById)}
              onWord={() => void downloadWeekly(weekly, episodeById, podcastById)}
              onEmail={userEmail ? () => emailWeeklyEdition([userEmail, ...extraRecipients], weekly, episodeById, podcastById) : undefined}
              recipients={
                userEmail
                  ? { self: userEmail, others: extraRecipients, onAdd: addExtraRecipient, onRemove: removeExtraRecipient }
                  : undefined
              }
            />
          )}
        </div>
      </div>

      {/* Process this week's not-yet-summarised episodes so the Monday brief is complete. */}
      {(unprocessed.length > 0 || weekProcessing) && (
        <div className="animate-fade-up mb-md flex items-center gap-3 rounded-xl border border-[#ecddb6] bg-[#fdf8ee] px-4 py-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#b8902f] text-white">
            <Icon name={weekProcessing ? 'progress_activity' : 'bolt'} size={18} className={weekProcessing ? 'animate-spin' : ''} />
          </span>
          <div className="min-w-0 flex-1">
            {weekProcessing ? (
              <>
                <p className="text-[13.5px] font-semibold text-on-surface">
                  Processing {Math.min(weekProgress.done + 1, weekProgress.total)} of {weekProgress.total}…
                </p>
                <p className="truncate text-[12px] text-secondary">{weekProgress.title || 'Finishing up…'}</p>
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[#efe3c6]">
                  <div className="h-full rounded-full bg-[#b8902f] transition-[width] duration-300 ease-out" style={{ width: `${weekProgress.total ? (weekProgress.done / weekProgress.total) * 100 : 0}%` }} />
                </div>
              </>
            ) : (
              <>
                <p className="text-[13.5px] font-semibold text-on-surface">
                  {unprocessed.length} meeting{unprocessed.length === 1 ? '' : 's'} from this week {unprocessed.length === 1 ? "isn't" : "aren't"} processed yet
                </p>
                <p className="text-[12px] text-secondary">{needsApiKey ? 'Connect an AI key to process them.' : 'Process them so the Monday brief includes everything.'}</p>
              </>
            )}
          </div>
          {weekProcessing ? (
            <button
              onClick={cancelProcessWeek}
              className="press shrink-0 rounded-lg border border-outline-variant bg-surface px-3 py-2 text-metadata font-semibold text-on-surface hover:bg-surface-container-low"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={processAll}
              disabled={needsApiKey}
              className="press inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[#b8902f] px-3.5 py-2 text-metadata font-semibold text-white hover:bg-[#a87f28] disabled:opacity-50"
            >
              <Icon name="auto_awesome" size={15} /> Process all
            </button>
          )}
        </div>
      )}

      {/* New episodes detected since the saved edition — visible, opt-in refresh. */}
      {weekly && newEpisodes.length > 0 && (
        <button
          onClick={refresh}
          disabled={refreshing}
          className="press-soft animate-fade-up mb-md flex w-full items-center gap-3 rounded-xl border border-primary/30 bg-[#eff5ff] px-4 py-3 text-left hover:bg-[#e6efff] disabled:opacity-70"
        >
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary text-on-primary">
            <Icon name="fiber_new" size={18} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13.5px] font-semibold text-on-surface">
              {newEpisodes.length} new meeting{newEpisodes.length === 1 ? '' : 's'} detected since this edition
            </span>
            <span className="block text-[12px] text-secondary">Showing the saved version — refresh to fold in the latest.</span>
          </span>
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-metadata font-semibold text-on-primary">
            <Icon name="refresh" size={15} /> <span className="hidden sm:inline">Refresh</span>
          </span>
        </button>
      )}

      {loading || weekly === undefined ? (
        <GeneratingState count={editionEpisodes.length} />
      ) : weekly === null ? (
        <EmptyState />
      ) : (
        <WeeklyDoc
          weekly={weekly}
          ready={editionEpisodes}
          trackedCount={podcasts.filter((p) => p.tracked).length}
          episodeById={episodeById}
        />
      )}

      {chatOpen && (
        <WeeklyChat week={currentKey} meetings={chatMeetings} rangeLabel={chatRange} onClose={() => setChatOpen(false)} />
      )}
    </div>
  )
}

// ── The rendered document ────────────────────────────────────────────────────
function WeeklyDoc({
  weekly,
  ready,
  trackedCount,
  episodeById,
}: {
  weekly: WeeklySummary
  ready: ReturnType<typeof useAppData>['episodes']
  trackedCount: number
  episodeById: ReturnType<typeof useAppData>['episodeById']
}) {
  const [active, setActive] = useState('overview')
  const terms = entityTerms(weekly.mentions)
  const shows = weekly.shows ?? [] // older cached digests predate the by-show shape
  const ideaCount = shows.reduce((n, s) => n + s.ideas.length, 0)

  // The synthesised Guidepoint key-points layer (present once an LLM key has run;
  // otherwise the deterministic fallback baked into assembleWeekly).
  const keyThemes = weekly.keyThemes ?? []
  const citations = weekly.citations ?? []
  const synthesised = keyThemes.length > 0
  const epForCite = (index: number) => episodeById(citations.find((c) => c.index === index)?.episodeId ?? '')

  const stats = [
    { icon: 'play_circle', label: 'Meetings Processed', value: weekly.episodeCount, style: THEME_STYLES[0] },
    { icon: 'trending_up', label: 'Ideas Pitched', value: ideaCount, style: THEME_STYLES[1] },
    { icon: 'help', label: 'Questions Answered', value: ready.reduce((n, e) => n + (e.summary?.qa.length ?? 0), 0), style: THEME_STYLES[2] },
    { icon: 'forum', label: 'Meetings', value: trackedCount, style: THEME_STYLES[3] },
  ]

  // Only Overview, Per Person, and Key Points — the rest of the Guidepoint-shaped
  // sections (Quantitative, Investment Readout, by-show, Top Themes, Mentions,
  // Interesting, Sources) are hidden from the weekly by design.
  const nav = [
    { id: 'overview', label: 'Overview', icon: 'play_circle', show: weekly.overview.length > 0 },
    { id: 'people', label: 'Per Person', icon: 'groups', show: true },
    { id: 'key-points', label: 'Key Points', icon: 'format_list_bulleted', show: synthesised },
  ].filter((n) => n.show)

  function go(id: string) {
    setActive(id)
    document.getElementById(`wk-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="grid grid-cols-12 gap-gutter">
      {/* In-page sub-nav */}
      <nav className="col-span-12 md:col-span-3">
        <ul className="sticky top-20 flex flex-col gap-0.5">
          {nav.map((n) => (
            <li key={n.id}>
              <button
                onClick={() => go(n.id)}
                className={`press-soft flex w-full items-center gap-2.5 rounded-lg border-l-2 px-3 py-2 text-left text-[14px] ${
                  active === n.id
                    ? 'border-primary bg-primary-fixed/50 font-semibold text-primary'
                    : 'border-transparent text-secondary hover:bg-surface-container-low hover:text-on-surface'
                }`}
              >
                <Icon name={n.icon} size={18} /> {n.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {/* Content */}
      <div className="col-span-12 md:col-span-9">
        <div className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-lg shadow-card">
          {/* Overview + at-a-glance stats */}
          {weekly.overview.length > 0 && (
            <section id="wk-overview" className="scroll-mt-20">
              <h2 className="mb-md text-[22px] font-bold tracking-tight text-on-surface">This Week in Summary</h2>
              <div className="space-y-md text-body-md leading-relaxed text-on-surface-variant">
                {weekly.overview.map((p, i) => (
                  <p key={i}>
                    <Cited text={p} terms={terms} epForCite={epForCite} />
                  </p>
                ))}
              </div>
              <div className="mt-lg grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                {stats.map((s) => (
                  <div key={s.label} className="rounded-xl border border-outline-variant bg-surface-container-low p-3">
                    <span className={`mb-2 grid h-9 w-9 place-items-center rounded-lg border ${s.style.tile}`}>
                      <Icon name={s.icon} size={18} />
                    </span>
                    <p className="text-[24px] font-bold leading-none text-on-surface">{s.value}</p>
                    <p className="mt-1 text-[12px] text-secondary">{s.label}</p>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Per-person rollup — overall / accomplished / to-do for each participant */}
          <WeeklyPeople />

          {/* Key Points — synthesised, claim-first, cross-episode (the primary body) */}
          {synthesised && (
            <Block id="wk-key-points" title="Key Points">
              <div className="space-y-lg">
                {keyThemes.map((t, i) => (
                  <div key={i}>
                    <h4 className="mb-2.5 text-[15px] font-semibold text-on-surface">{t.heading}</h4>
                    <ul className="space-y-2">
                      {t.points.map((p, j) => (
                        <li key={j} className="flex gap-2.5 text-body-md text-on-surface-variant">
                          <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                          <span>
                            <Cited text={p} terms={terms} epForCite={epForCite} />
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </Block>
          )}

        </div>
      </div>
    </div>
  )
}

function Block({ id, title, first, children }: { id: string; title: string; first?: boolean; children: ReactNode }) {
  return (
    <section id={id} className={`scroll-mt-20 ${first ? '' : 'mt-lg border-t border-outline-variant pt-lg'}`}>
      <h3 className="mb-md text-[17px] font-semibold text-on-surface">{title}</h3>
      {children}
    </section>
  )
}

// Render text with inline `[n]` citations turned into small gold superscript links
// back to the source episode (matching the PDF's gold markers). Non-citation spans
// keep the usual **bold** + entity-term treatment via RichText.
function Cited({ text, terms, epForCite }: { text: string; terms: string[]; epForCite: (n: number) => ReturnType<ReturnType<typeof useAppData>['episodeById']> }) {
  const parts = text.split(/(\[\d+\])/)
  return (
    <>
      {parts.map((part, i) => {
        const m = /^\[(\d+)\]$/.exec(part)
        if (!m) return <RichText key={i} text={part} terms={terms} />
        const n = Number(m[1])
        const ep = epForCite(n)
        const marker = (
          <sup className="text-[0.7em] font-semibold text-primary">{part}</sup>
        )
        return ep ? (
          <Link key={i} to={`/meetings/${ep.id}`} className="hover:underline" aria-label={`Source ${n}: ${ep.title}`}>
            {marker}
          </Link>
        ) : (
          <span key={i}>{marker}</span>
        )
      })}
    </>
  )
}

function GeneratingState({ count }: { count: number }) {
  return (
    <div className="grid place-items-center gap-sm rounded-2xl border border-outline-variant bg-surface-container-lowest py-[14vh] text-center shadow-card">
      <Icon name="auto_awesome" size={30} className="text-primary motion-safe:animate-pulse" fill />
      <p className="text-body-md font-semibold text-on-surface">Synthesising your weekly summary…</p>
      <p className="max-w-sm text-metadata text-secondary">
        Reading across {count} analysed meeting{count === 1 ? '' : 's'} to find the through-line, themes, and what actually mattered.
      </p>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="grid place-items-center gap-sm rounded-2xl border border-dashed border-outline-variant bg-surface-container-low py-[14vh] text-center">
      <Icon name="summarize" size={32} className="text-outline" />
      <h3 className="text-display-sm text-on-surface-variant">No weekly summary yet</h3>
      <p className="max-w-md text-body-md text-secondary">
        Your weekly master summary is built from analysed meetings. Once a few meetings are summarised, the cross-meeting
        synthesis appears here — drawn entirely from real content.
      </p>
      <Link to="/meetings" className="press mt-1 inline-flex items-center gap-2 rounded-lg bg-primary px-lg py-2.5 text-metadata font-semibold text-on-primary hover:bg-primary-container">
        <Icon name="play_circle" size={18} /> Go to Meetings
      </Link>
    </div>
  )
}
