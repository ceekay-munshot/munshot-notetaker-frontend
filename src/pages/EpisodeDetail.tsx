import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useAppData } from '../store/AppData'
import { useSentiment } from '../store/Sentiment'
import { downloadSummary } from '../lib/exportSummary'
import { downloadSummaryPdf } from '../lib/pdfRender'
import { emailEpisodeSummary, registerWeeklyRecipient, unregisterWeeklyRecipient } from '../lib/api'
import { addRecipient, loadRecipients, removeRecipient } from '../lib/recipientsStore'
import { formatDuration, longDate, statusMeta } from '../lib/format'
import type { Episode, EpisodeInsight, ProcessingStatus, QuantPoint, Takeaway, TranscriptSegment } from '../lib/types'
import { CoverTile } from '../components/CoverTile'
import { Icon } from '../components/Icon'
import { DownloadMenu } from '../components/DownloadMenu'
import { readSubscribedEmail } from '../components/WeeklySubscribe'
import { RichText, entityTerms } from '../components/RichText'
import { analyzeSentiment, findSentimentSpans, sentimentClass, sentimentTitle } from '../lib/sentiment'
import { keyHighlights } from '../lib/highlights'
import { episodeToneView } from '../lib/tone'
import { ToneMeter } from '../components/ToneMeter'
import { SourceLink } from '../components/SourceLink'
import { StatusBadge } from '../components/StatusBadge'
import { anchorSegment } from '../lib/topics'

type Tab = 'summary' | 'highlights' | 'qa' | 'transcript'

// Old deep links (the two tabs this one replaced) still land somewhere sensible.
const LEGACY_TABS: Record<string, Tab> = { takeaways: 'highlights', moments: 'highlights' }

// Colored styling for highlight tiles, cycled by index.
const TILES = [
  { icon: 'hub', text: 'text-[#2563eb]', tile: 'bg-[#eff5ff]', pill: 'bg-[#eff5ff] text-[#2563eb]' },
  { icon: 'memory', text: 'text-[#16a34a]', tile: 'bg-[#ecfdf3]', pill: 'bg-[#ecfdf3] text-[#15803d]' },
  { icon: 'trending_up', text: 'text-[#7c3aed]', tile: 'bg-[#f5f3ff]', pill: 'bg-[#f5f3ff] text-[#7c3aed]' },
  { icon: 'account_balance', text: 'text-[#ea7317]', tile: 'bg-[#fff4ec]', pill: 'bg-[#fff4ec] text-[#c2410c]' },
  { icon: 'developer_board', text: 'text-[#0d9488]', tile: 'bg-[#eefcfb]', pill: 'bg-[#eefcfb] text-[#0d9488]' },
]

export default function EpisodeDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { episodeById, podcastById, summarizeEpisode, needsApiKey, identity } = useAppData()
  const { on: sentimentOn } = useSentiment()

  // Where "Email this edition" sends: the signed-in user's address, or the one
  // they subscribed the weekly brief with. Absent → the email item is hidden.
  // Mirrors the Weekly page exactly (same recipient list + Monday-digest wiring).
  const userEmail = identity?.email || readSubscribedEmail()
  const [extraRecipients, setExtraRecipients] = useState<string[]>([])
  useEffect(() => {
    const saved = loadRecipients()
    setExtraRecipients(saved)
    // Self-heal: make sure every saved recipient is on the durable digest list.
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
    void unregisterWeeklyRecipient(addr)
  }

  const raw = params.get('tab')
  const paramTab = raw ? (LEGACY_TABS[raw] ?? (raw as Tab)) : null
  const [tab, setTab] = useState<Tab>(paramTab ?? 'summary')
  const [jumpTo, setJumpTo] = useState<string | null>(null)
  const [jumpTick, setJumpTick] = useState(0) // re-fires the scroll even when re-jumping the same segment
  const [jumpLabel, setJumpLabel] = useState<string | undefined>(undefined) // the highlight we jumped from
  const [refreshing, setRefreshing] = useState(false)

  const episode = id ? episodeById(id) : undefined
  const podcast = episode ? podcastById(episode.podcastId) : undefined

  // React Router reuses this component across /episodes/:id changes, so the
  // useState initializer above runs only once. Re-sync the active tab whenever the
  // episode (or its ?tab=) changes, so a deep link to another episode's transcript
  // lands on that tab instead of the stale one. Plain tab clicks (which don't touch
  // the URL or id) leave these deps unchanged, so a user's selection still sticks.
  useEffect(() => {
    setTab(paramTab ?? 'summary')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, paramTab])

  useEffect(() => {
    if (tab !== 'transcript' || !jumpTo) return
    const el = document.getElementById(`seg-${jumpTo}`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('seg-flash')
    const mark = el.querySelector('.transcript-mark')
    mark?.classList.add('is-active')
    const t = setTimeout(() => {
      el.classList.remove('seg-flash')
      mark?.classList.remove('is-active')
    }, 2000)
    return () => clearTimeout(t)
  }, [tab, jumpTo, jumpTick])

  // When an episode is opened, kick AppData's summarizeEpisode, which either
  // generates the summary (a new episode) or hydrates the transcript (a SHARED
  // episode whose summary arrived via the feed overlay without its transcript —
  // the store hit costs no LLM/transcription). Idempotent — AppData dedupes per id.
  useEffect(() => {
    if (!episode || episode.status === 'failed') return
    const needsWork =
      (!episode.summary && !!episode.notes) ||
      (!!episode.summary && !episode.transcript?.length && !!(episode.transcriptUrl || episode.audioUrl))
    if (needsWork) summarizeEpisode(episode, podcast)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episode?.id])

  if (!episode || !podcast) {
    return (
      <div className="grid place-items-center py-[20vh] text-center">
        <Icon name="error" size={36} className="mb-sm text-outline" />
        <p className="text-body-md text-secondary">That episode could not be found.</p>
        <Link to="/episodes" className="mt-sm text-metadata font-semibold text-primary hover:underline">
          Back to episodes
        </Link>
      </div>
    )
  }

  const hasTranscript = !!episode.transcript?.length
  const TABS: { id: Tab; label: string; show: boolean }[] = [
    { id: 'summary', label: 'Summary', show: true },
    { id: 'highlights', label: 'Highlights', show: !!episode.summary?.highlights.length },
    { id: 'qa', label: 'Q&A', show: !!episode.summary?.qa.length },
    { id: 'transcript', label: 'Transcript', show: true },
  ]

  function openTranscript(segmentId?: string, label?: string) {
    setTab('transcript')
    if (segmentId) {
      setJumpTo(segmentId)
      setJumpLabel(label)
      setJumpTick((n) => n + 1)
    }
  }

  // Force-regenerate this episode's summary, bypassing the server + client caches
  // (and overwriting them). The content stays visible until the fresh version lands.
  async function refreshSummary() {
    if (!episode?.summary || refreshing) return
    setRefreshing(true)
    try {
      await summarizeEpisode(episode, podcast, { force: true })
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="animate-fade-up">
      <button
        onClick={() => navigate(-1)}
        className="mb-md inline-flex items-center gap-1 text-metadata font-semibold text-primary transition-colors hover:underline"
      >
        <Icon name="arrow_back" size={16} /> Back to Episodes
      </button>

      {/* Header */}
      <div className="mb-lg flex flex-col gap-md sm:flex-row sm:items-start">
        <CoverTile podcast={podcast} className="h-28 w-28 shrink-0" rounded="rounded-xl" />
        <div className="flex-1">
          <div className="mb-1 flex items-center gap-2">
            <CoverTile podcast={podcast} className="h-5 w-5" rounded="rounded" />
            <span className="text-metadata font-semibold text-on-surface">{podcast.title}</span>
            <span className="text-metadata text-secondary">· {podcast.author}</span>
          </div>
          <h1 className="mb-2 text-display-lg tracking-tight text-on-surface">{episode.title}</h1>
          <div className="flex flex-wrap items-center gap-3 text-metadata text-secondary">
            <span className="inline-flex items-center gap-1">
              <Icon name="calendar_today" size={15} /> {longDate(episode.publishedAt)}
            </span>
            <span className="inline-flex items-center gap-1">
              <Icon name="schedule" size={15} /> {formatDuration(episode.durationSec)}
            </span>
            <StatusBadge status={episode.status} />
          </div>
          {episode.summary && sentimentOn && <ToneMeter tone={episodeToneView(episode)} detailed className="mt-3" />}
        </div>
        <div className="flex items-center gap-2.5">
          <SourceLink episode={episode} podcast={podcast} />
          {episode.summary && (
            <button
              onClick={refreshSummary}
              disabled={refreshing}
              title="Regenerate this summary from scratch (skips the cache) — use after shipping a new format"
              className="press inline-flex items-center gap-2 rounded-lg border border-outline-variant bg-surface px-3 py-2.5 text-metadata font-semibold text-on-surface hover:bg-surface-container-low disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Icon name="refresh" size={18} className={refreshing ? 'motion-safe:animate-spin' : ''} />
              <span className="hidden sm:inline">{refreshing ? 'Refreshing…' : 'Refresh'}</span>
            </button>
          )}
          <DownloadMenu
            disabled={!episode.summary}
            onPdf={() => void downloadSummaryPdf(episode, podcast)}
            onWord={() => void downloadSummary(episode, podcast)}
            onEmail={userEmail && episode.summary ? () => emailEpisodeSummary([userEmail, ...extraRecipients], episode, podcast) : undefined}
            recipients={
              userEmail
                ? { self: userEmail, others: extraRecipients, onAdd: addExtraRecipient, onRemove: removeExtraRecipient }
                : undefined
            }
          />
        </div>
      </div>

      {episode.status !== 'ready' || !episode.summary ? (
        <ProcessingPanel episode={episode} needsApiKey={needsApiKey} onRetry={() => summarizeEpisode(episode, podcast)} />
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

          {tab === 'summary' && <SummaryTab episode={episode} />}
          {tab === 'highlights' && <HighlightsTab episode={episode} hasTranscript={hasTranscript} onOpen={openTranscript} />}
          {tab === 'qa' && <QATab episode={episode} />}
          {tab === 'transcript' && (
            <TranscriptTab episode={episode} focusId={jumpTo} focusLabel={jumpLabel} focusTick={jumpTick} />
          )}
        </>
      )}
    </div>
  )
}

// ── Summary tab — an institution-grade brief ─────────────────────────────────
function SummaryTab({ episode }: { episode: Episode }) {
  const { on: sentimentOn } = useSentiment()
  const s = episode.summary!
  const terms = entityTerms(episode.entities)

  // Split the key takeaways (the highlights the AI flagged) into a bull / bear /
  // neutral read by net sentiment, so the brief leads with what's working and
  // what to watch — not a flat wall.
  const takeaways = useMemo(() => keyHighlights(s), [s])
  const groups = useMemo(() => {
    const pos: Takeaway[] = []
    const neg: Takeaway[] = []
    const neutral: Takeaway[] = []
    for (const t of takeaways) {
      const score = analyzeSentiment(`${t.title}. ${t.detail}`).score
      ;(score > 0 ? pos : score < 0 ? neg : neutral).push(t)
    }
    return { pos, neg, neutral }
  }, [takeaways])

  // Show the bull/bear split only when there's a real lean on either side;
  // otherwise fall back to a clean bulleted read (also when coloring is off).
  const split = sentimentOn && (groups.pos.length > 0 || groups.neg.length > 0)

  const glance = [
    { icon: 'star', label: 'Highlights', value: s.highlights.length },
    { icon: 'help', label: 'Q&A', value: s.qa.length },
  ]

  return (
    <div className="grid grid-cols-12 gap-gutter">
      <section className="col-span-12 rounded-2xl border border-outline-variant bg-surface-container-lowest p-lg shadow-card md:col-span-8">
        <div className="mb-md flex items-center gap-2 text-primary">
          <Icon name="auto_awesome" fill />
          <h2 className="text-[19px] font-semibold text-on-surface">AI Summary</h2>
        </div>
        {/* Overview — lead paragraph reads larger + darker for editorial
            hierarchy; the rest settle into calm body text. */}
        <div className="space-y-4">
          {s.synthesis.map((p, i) => (
            <p
              key={i}
              className={
                i === 0
                  ? 'text-body-lg leading-relaxed text-on-surface'
                  : 'text-body-md leading-relaxed text-on-surface-variant'
              }
            >
              <RichText text={p} terms={terms} />
            </p>
          ))}
        </div>

        {/* Investable insight — the analyst read (what changed / why it matters /
            who benefits / who's at risk / diligence) when the summary has it. It
            supersedes the heuristic bull-bear split below. */}
        {s.insight ? (
          <InsightCard insight={s.insight} quantData={s.quantData} terms={terms} />
        ) : split ? (
          <div className="mt-lg border-t border-outline-variant pt-lg">
            <div className="grid gap-3 sm:grid-cols-2">
              <SignalPanel kind="pos" items={groups.pos} terms={terms} />
              <SignalPanel kind="neg" items={groups.neg} terms={terms} />
            </div>
            <KeyPoints items={groups.neutral} terms={terms} heading="Other key points" className="mt-md" />
          </div>
        ) : (
          <KeyPoints
            items={takeaways}
            terms={terms}
            heading="Key points"
            className="mt-lg border-t border-outline-variant pt-lg"
          />
        )}

        {/* Ideas pitched — concrete stock/macro/trade calls + the thesis behind each.
            Only shown when the episode actually pitched something specific. */}
        {s.ideas && s.ideas.length > 0 && (
          <div className="mt-lg border-t border-outline-variant pt-lg">
            <div className="mb-md flex items-center gap-2 text-primary">
              <Icon name="trending_up" size={20} />
              <h3 className="text-[17px] font-semibold text-on-surface">Ideas Pitched</h3>
            </div>
            <ul className="space-y-2.5">
              {s.ideas.map((idea, i) => (
                <li key={i} className="rounded-xl border border-outline-variant bg-surface-container-low p-md">
                  <p className="text-body-md font-semibold text-on-surface">
                    {idea.kind && (
                      <span className="mr-2 inline-block rounded bg-primary-fixed/70 px-1.5 py-0.5 align-middle text-[10px] font-bold uppercase tracking-wide text-primary">
                        {idea.kind}
                      </span>
                    )}
                    <RichText text={idea.idea} terms={terms} />
                  </p>
                  {idea.proponent && idea.proponent !== '—' && (
                    <p className="mt-1 text-metadata text-secondary">Pitched by {idea.proponent}</p>
                  )}
                  {idea.thesis.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {idea.thesis.map((t, j) => (
                        <li key={j} className="flex gap-2 text-[13.5px] leading-snug text-on-surface-variant">
                          <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-secondary" />
                          <span>
                            <RichText text={t} terms={terms} />
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <aside className="col-span-12 md:col-span-4">
        <div className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-md shadow-card">
          <div className="mb-md flex items-center gap-2 text-primary">
            <Icon name="visibility" />
            <h2 className="text-[17px] font-semibold text-on-surface">At a Glance</h2>
          </div>
          <ul className="flex flex-col gap-1">
            {glance.map((g) => (
              <li key={g.label} className="flex items-center gap-3 py-1.5">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg chip-signal">
                  <Icon name={g.icon} size={20} />
                </span>
                <div>
                  <p className="text-metadata text-secondary">{g.label}</p>
                  <p className="text-[20px] font-bold leading-tight text-on-surface">{g.value}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  )
}

// Investable-insight card — the five-part analyst read. Leads with what changed /
// why it matters, then named winners vs at-risk parties (icon + label, never color
// alone), the hard numbers, and the diligence questions to chase next. Each section
// is omitted when empty so a thin episode never shows hollow scaffolding.
function InsightCard({ insight, quantData, terms }: { insight: EpisodeInsight; quantData?: QuantPoint[]; terms: string[] }) {
  const hasParties = insight.beneficiaries.length > 0 || insight.atRisk.length > 0
  return (
    <div className="mt-lg border-t border-outline-variant pt-lg">
      <div className="mb-md flex items-center gap-2 text-primary">
        <Icon name="insights" size={20} />
        <h3 className="text-[17px] font-semibold text-on-surface">Investable Insight</h3>
      </div>
      <div className="space-y-3.5">
        {insight.whatChanged && (
          <div>
            <p className="text-label-caps uppercase text-secondary">What changed</p>
            <p className="mt-1 text-body-md leading-relaxed text-on-surface">
              <RichText text={insight.whatChanged} terms={terms} />
            </p>
          </div>
        )}
        {insight.whyItMatters && (
          <div>
            <p className="text-label-caps uppercase text-secondary">Why it matters</p>
            <p className="mt-1 text-body-md leading-relaxed text-on-surface-variant">
              <RichText text={insight.whyItMatters} terms={terms} />
            </p>
          </div>
        )}
      </div>

      {hasParties && (
        <div className="mt-md grid gap-3 sm:grid-cols-2">
          <PartyPanel kind="pos" items={insight.beneficiaries} terms={terms} />
          <PartyPanel kind="neg" items={insight.atRisk} terms={terms} />
        </div>
      )}

      {quantData && quantData.length > 0 && (
        <div className="mt-md">
          <p className="mb-2 text-label-caps uppercase text-secondary">Key numbers</p>
          <div className="overflow-hidden rounded-xl border border-outline-variant">
            <table className="w-full border-collapse text-[13.5px]">
              <tbody>
                {quantData.map((q, i) => (
                  <tr key={i} className="border-b border-outline-variant last:border-0 even:bg-surface-container-low">
                    <td className="px-3 py-2 align-top text-on-surface">{q.metric}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right align-top font-semibold tabular-nums text-on-surface">{q.value}</td>
                    <td className="px-3 py-2 align-top text-on-surface-variant">{q.context}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {insight.diligenceQuestions.length > 0 && (
        <div className="mt-md">
          <p className="mb-2 text-label-caps uppercase text-secondary">Diligence questions</p>
          <ul className="space-y-2">
            {insight.diligenceQuestions.map((q, i) => (
              <li key={i} className="flex gap-2.5 text-body-md text-on-surface-variant">
                <Icon name="help" size={16} className="mt-0.5 shrink-0 text-secondary" />
                <span>{q}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// Named winners / at-risk parties — name + the specific mechanism. Mirrors
// SignalPanel's green/red treatment with an icon + label (not color alone).
function PartyPanel({ kind, items, terms }: { kind: 'pos' | 'neg'; items: { name: string; why: string }[]; terms: string[] }) {
  const pos = kind === 'pos'
  return (
    <div className={`rounded-xl border p-md ${pos ? 'border-[#d6efdf] bg-[#f5fbf7]' : 'border-[#f3d8d8] bg-[#fdf6f6]'}`}>
      <div className="mb-2.5 flex items-center gap-1.5">
        <Icon name={pos ? 'trending_up' : 'warning'} size={18} className={pos ? 'text-[#15803d]' : 'text-[#b91c1c]'} />
        <h4 className={`text-[14px] font-semibold ${pos ? 'text-[#15803d]' : 'text-[#b91c1c]'}`}>{pos ? 'Who benefits' : "Who's at risk"}</h4>
      </div>
      {items.length ? (
        <ul className="space-y-2.5">
          {items.map((p, i) => (
            <li key={i} className="flex gap-2">
              <span className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${pos ? 'bg-[#16a34a]' : 'bg-[#dc2626]'}`} />
              <div className="min-w-0">
                <p className="text-[14px] font-semibold text-on-surface">{p.name}</p>
                <p className="mt-0.5 text-[13px] leading-snug text-on-surface-variant">
                  <RichText text={p.why} terms={terms} />
                </p>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-secondary">{pos ? 'No clear beneficiary named.' : 'No party flagged at risk.'}</p>
      )}
    </div>
  )
}

// Bull / bear panel built from the takeaways that lean that way. Honest empty
// states so a one-sided episode still reads as a considered call, not a gap.
function SignalPanel({ kind, items, terms }: { kind: 'pos' | 'neg'; items: Takeaway[]; terms: string[] }) {
  const pos = kind === 'pos'
  return (
    <div className={`rounded-xl border p-md ${pos ? 'border-[#d6efdf] bg-[#f5fbf7]' : 'border-[#f3d8d8] bg-[#fdf6f6]'}`}>
      <div className="mb-2.5 flex items-center gap-1.5">
        <Icon name={pos ? 'trending_up' : 'trending_down'} size={18} className={pos ? 'text-[#15803d]' : 'text-[#b91c1c]'} />
        <h3 className={`text-[14px] font-semibold ${pos ? 'text-[#15803d]' : 'text-[#b91c1c]'}`}>
          {pos ? 'Positives' : 'Risks & watch-outs'}
        </h3>
      </div>
      {items.length ? (
        <ul className="space-y-2.5">
          {items.map((t, i) => (
            <li key={i} className="flex gap-2">
              <span className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${pos ? 'bg-[#16a34a]' : 'bg-[#dc2626]'}`} />
              <div className="min-w-0">
                <p className="text-[14px] font-semibold text-on-surface">{t.title}</p>
                <p className="mt-0.5 text-[13px] leading-snug text-on-surface-variant">
                  <RichText text={t.detail} terms={terms} />
                </p>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-secondary">
          {pos ? 'No clear positives flagged in this analysis.' : 'No notable risks flagged in this analysis.'}
        </p>
      )}
    </div>
  )
}

// Neutral key points — takeaways that don't lean either way (or all of them when
// sentiment coloring is off). Matches the Home/Weekly bullet style.
function KeyPoints({
  items,
  terms,
  heading,
  className = '',
}: {
  items: Takeaway[]
  terms: string[]
  heading: string
  className?: string
}) {
  if (!items.length) return null
  return (
    <div className={className}>
      <h3 className="mb-2.5 text-[15px] font-semibold text-on-surface">{heading}</h3>
      <ul className="space-y-2">
        {items.map((t, i) => (
          <li key={i} className="flex gap-2.5 text-body-md text-on-surface-variant">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
            <span>
              <span className="font-semibold text-on-surface">{t.title}.</span>{' '}
              <RichText text={t.detail} terms={terms} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── Highlights tab — the merged takeaways + moments read ─────────────────────
// One timeline of colored tiles: every beat worth revisiting, each with a
// timestamp that jumps into the transcript; the AI's headline takeaways carry
// a quiet "Key" badge instead of living in a near-duplicate second tab.
function HighlightsTab({
  episode,
  hasTranscript,
  onOpen,
}: {
  episode: Episode
  hasTranscript: boolean
  onOpen: (segmentId?: string, label?: string) => void
}) {
  const highlights = episode.summary!.highlights
  const terms = entityTerms(episode.entities)
  const segments = episode.transcript
  // Items the server didn't link to a row (older data, fuzzy timestamps) still
  // jump: fall back to anchoring on the passage the text was drawn from.
  const anchors = useMemo(
    () => highlights.map((h) => h.segmentId ?? anchorSegment(`${h.title} ${h.detail}`, segments)),
    [highlights, segments],
  )
  const copyLine = (h: (typeof highlights)[number]) =>
    `${h.timestamp !== '—' ? `${h.timestamp} — ` : ''}${h.title}: ${h.detail}`

  return (
    <section>
      <div className="mb-md flex items-center justify-between gap-sm">
        <div className="flex items-center gap-2">
          <Icon name="auto_awesome" className="text-primary" fill />
          <div>
            <h2 className="text-[19px] font-semibold text-on-surface">Highlights</h2>
            <p className="text-metadata text-secondary">
              Every moment worth revisiting — <Icon name="star" size={12} fill className="relative -top-px inline text-primary" />{' '}
              marks the key takeaways.
            </p>
          </div>
        </div>
        <CopyButton text={highlights.map(copyLine).join('\n')} label="Copy All" />
      </div>

      <ul className="flex flex-col gap-2.5">
        {highlights.map((h, i) => {
          const style = TILES[i % TILES.length]
          const anchor = hasTranscript ? anchors[i] : null
          return (
            <li key={h.id}>
              <div
                role={anchor ? 'button' : undefined}
                tabIndex={anchor ? 0 : undefined}
                onClick={anchor ? () => onOpen(anchor, h.title) : undefined}
                onKeyDown={
                  anchor
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          onOpen(anchor, h.title)
                        }
                      }
                    : undefined
                }
                className={`group flex w-full items-start gap-md rounded-xl border border-outline-variant bg-surface-container-lowest p-md text-left shadow-card ${
                  anchor ? 'lift cursor-pointer hover:shadow-card-hover focus:outline-none focus-visible:border-primary' : ''
                }`}
              >
                <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-lg ${style.tile}`}>
                  <Icon name={style.icon} size={22} className={style.text} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-[16px] font-semibold text-on-surface">{h.title}</p>
                    {h.key && (
                      <span
                        title="Flagged by the AI as a key takeaway"
                        className="inline-flex shrink-0 items-center gap-1 rounded-full chip-signal px-2 py-0.5 text-label-caps uppercase"
                      >
                        <Icon name="star" size={11} fill /> Key
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-body-md text-on-surface-variant">
                    <RichText text={h.detail} terms={terms} />
                  </p>
                  {anchor && (
                    <span className="mt-2 inline-flex items-center gap-1 text-metadata font-semibold text-primary opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100">
                      <Icon name="article" size={15} /> Open in transcript
                      <Icon name="arrow_forward" size={14} className="transition-transform group-hover:translate-x-0.5" />
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {h.timestamp !== '—' && (
                    <span className={`rounded-md px-2.5 py-1 text-metadata font-semibold ${style.pill}`}>{h.timestamp}</span>
                  )}
                  <CopyButton text={copyLine(h)} />
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

// ── Q&A tab ──────────────────────────────────────────────────────────────────
function QATab({ episode }: { episode: Episode }) {
  const s = episode.summary!
  const terms = entityTerms(episode.entities)
  return (
    <section className="rounded-2xl border border-outline-variant bg-surface-container-lowest shadow-card">
      <ul className="divide-y divide-outline-variant">
        {s.qa.map((item, i) => (
          <li key={i} className="flex items-start gap-md p-md">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg chip-signal text-metadata font-bold">{i + 1}</span>
            <div>
              <h3 className="mb-1.5 text-[16px] font-semibold text-on-surface">{item.q}</h3>
              <p className="text-body-md leading-relaxed text-on-surface-variant">
                <RichText text={item.a} terms={terms} />
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

// ── Transcript tab — Highlights list ↔ transcript ────────────────────────────
function TranscriptTab({
  episode,
  focusId,
  focusLabel,
  focusTick,
}: {
  episode: Episode
  focusId?: string | null
  focusLabel?: string
  focusTick?: number
}) {
  const { on: sentimentOn } = useSentiment()
  const [activeRef, setActiveRef] = useState<string | null>(null)
  // The segment we jumped to from a highlight — stays highlighted so the
  // reader knows exactly which passage the summary point came from.
  const [focus, setFocus] = useState<{ id: string; label?: string } | null>(
    focusId ? { id: focusId, label: focusLabel } : null,
  )
  const [q, setQ] = useState('')
  const segments = episode.transcript ?? []
  const highlights = episode.summary?.highlights.filter((h) => h.segmentId) ?? []

  // Re-apply the persistent highlight whenever a fresh jump arrives.
  useEffect(() => {
    if (focusId) setFocus({ id: focusId, label: focusLabel })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTick])

  if (!segments.length) {
    return (
      <div className="grid place-items-center gap-sm rounded-2xl border border-dashed border-outline-variant bg-surface-container-low py-xl text-center">
        <Icon name="graphic_eq" size={32} className="text-outline" />
        <h3 className="text-[19px] font-semibold text-on-surface-variant">Transcript not ingested yet</h3>
        <p className="max-w-md text-body-md text-secondary">
          Once the transcription API returns this episode's text, the full transcript appears here with the summary's
          highlights linked inline.
        </p>
      </div>
    )
  }

  const needle = q.trim().toLowerCase()
  const visible = needle ? segments.filter((s) => s.text.toLowerCase().includes(needle)) : segments

  function jump(segmentId?: string, refId?: string) {
    setFocus(null) // a Highlights-panel pick takes over from the jumped-from focus
    if (refId) setActiveRef(refId)
    if (segmentId) document.getElementById(`seg-${segmentId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  return (
    <div className="grid grid-cols-12 gap-gutter">
      {/* Highlights */}
      <aside className="col-span-12 md:col-span-4">
        <div className="mb-2 flex items-center gap-2">
          <h3 className="text-[15px] font-semibold text-on-surface">Highlights</h3>
          <span className="grid h-5 min-w-5 place-items-center rounded-full chip-signal px-1.5 text-[11px] font-bold">
            {highlights.length}
          </span>
        </div>
        <ul className="flex flex-col gap-2">
          {highlights.map((h) => {
            const active = activeRef === h.id
            return (
              <li key={h.id}>
                <button
                  onMouseEnter={() => setActiveRef(h.id)}
                  onClick={() => jump(h.segmentId, h.id)}
                  className={`press-soft w-full rounded-lg border p-3 text-left ${
                    active ? 'border-l-4 border-primary bg-[#eff5ff]' : 'border-outline-variant bg-surface-container-lowest hover:bg-surface-container-low'
                  }`}
                >
                  <p className="flex items-center gap-1.5 text-metadata font-semibold text-primary">
                    {h.timestamp}
                    {h.key && <Icon name="star" size={12} fill />}
                  </p>
                  <p className="mt-0.5 text-[14px] font-medium text-on-surface">{h.title}</p>
                </button>
              </li>
            )
          })}
        </ul>
      </aside>

      {/* Transcript */}
      <article className="col-span-12 rounded-2xl border border-outline-variant bg-surface-container-lowest p-md shadow-card md:col-span-8">
        <div className="relative mb-md">
          <Icon name="search" size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-outline" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search transcript…"
            className="w-full rounded-lg border border-outline-variant bg-surface-container-low py-2 pl-10 pr-sm text-[14px] outline-none focus:border-primary focus:bg-surface"
          />
        </div>
        <div className="flex flex-col">
          {visible.map((seg) => (
            <TranscriptRow
              key={seg.id}
              seg={seg}
              activeRef={activeRef}
              onHover={setActiveRef}
              focused={focus?.id === seg.id}
              focusLabel={focus?.id === seg.id ? focus.label : undefined}
              sentimentOn={sentimentOn}
            />
          ))}
          {visible.length === 0 && <p className="py-md text-center text-metadata text-secondary">No lines match “{q}”.</p>}
        </div>
      </article>
    </div>
  )
}

function TranscriptRow({
  seg,
  activeRef,
  onHover,
  focused = false,
  focusLabel,
  sentimentOn,
}: {
  seg: TranscriptSegment
  activeRef: string | null
  onHover: (ref: string | null) => void
  /** The segment a highlight jumped to — persistently highlighted. */
  focused?: boolean
  focusLabel?: string
  sentimentOn: boolean
}) {
  const isActive = !!seg.highlight && activeRef === seg.highlight.refId
  // Net lean of the whole segment → a thin left accent so a long transcript is
  // scannable at a glance. Only shown when the line clearly leans one way.
  const accent = useMemo(() => {
    if (!sentimentOn) return ''
    const s = analyzeSentiment(seg.text)
    return s.confident ? (s.label === 'pos' ? 'seg-pos' : 'seg-neg') : ''
  }, [seg.text, sentimentOn])

  return (
    <div
      id={`seg-${seg.id}`}
      className={`scroll-mt-24 rounded-lg py-3 transition-colors ${
        focused
          ? 'border-l-4 border-primary bg-[#eff5ff] pl-3 pr-2'
          : isActive
            ? `${accent} bg-[#eff5ff] px-2`
            : `${accent} px-2`
      }`}
    >
      {focused && (
        <p className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold text-primary">
          <Icon name="my_location" size={14} className="shrink-0" />
          <span className="truncate">{focusLabel ?? 'You jumped here'}</span>
        </p>
      )}
      <div className="grid grid-cols-[64px_84px_1fr] gap-2">
        <span className="text-metadata font-semibold text-primary">{seg.timestamp}</span>
        <span className={`text-metadata font-semibold ${seg.role === 'guest' ? 'text-on-surface' : 'text-on-surface-variant'}`}>
          {seg.speaker}
        </span>
        <p className="text-body-md leading-relaxed text-on-surface">
          <TranscriptText seg={seg} activeRef={activeRef} onHover={onHover} sentimentOn={sentimentOn} />
        </p>
      </div>
    </div>
  )
}

// The moment <mark> stays the authoritative outer span; sentiment is applied
// independently inside before / quote / after, so the green/red layer can color
// words even within a highlighted quote without ever breaking the blue mark.
function TranscriptText({
  seg,
  activeRef,
  onHover,
  sentimentOn,
}: {
  seg: TranscriptSegment
  activeRef: string | null
  onHover: (ref: string | null) => void
  sentimentOn: boolean
}) {
  const hl = seg.highlight
  if (!hl || !hl.quote) return <SentimentText text={seg.text} on={sentimentOn} />
  const idx = seg.text.indexOf(hl.quote)
  if (idx === -1) return <SentimentText text={seg.text} on={sentimentOn} />
  return (
    <>
      <SentimentText text={seg.text.slice(0, idx)} on={sentimentOn} />
      <mark
        className={`transcript-mark ${activeRef === hl.refId ? 'is-active' : ''}`}
        onMouseEnter={() => onHover(hl.refId)}
        onMouseLeave={() => onHover(null)}
        title={hl.label}
      >
        <SentimentText text={hl.quote} on={sentimentOn} />
      </mark>
      <SentimentText text={seg.text.slice(idx + hl.quote.length)} on={sentimentOn} />
    </>
  )
}

// A plain string with inline green/red sentiment spans only (no number/entity
// tiers — that's RichText's job). Memoized so long transcripts stay smooth.
function SentimentText({ text, on }: { text: string; on: boolean }) {
  const nodes = useMemo<ReactNode[]>(() => {
    if (!on || !text) return [text]
    const spans = findSentimentSpans(text)
    if (!spans.length) return [text]
    const out: ReactNode[] = []
    let last = 0
    let key = 0
    for (const s of spans) {
      if (s.start > last) out.push(text.slice(last, s.start))
      out.push(
        <span key={key++} className={sentimentClass(s)} title={sentimentTitle(s)}>
          {text.slice(s.start, s.end)}
        </span>,
      )
      last = s.end
    }
    if (last < text.length) out.push(text.slice(last))
    return out
  }, [text, on])
  return <>{nodes}</>
}

// ── Copy button helper ───────────────────────────────────────────────────────
function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      },
      () => {},
    )
  }
  if (label) {
    return (
      <button
        onClick={copy}
        className="press inline-flex items-center gap-2 rounded-lg border border-outline-variant bg-surface px-3 py-2 text-metadata font-semibold text-on-surface hover:bg-surface-container-low"
      >
        <Icon name={copied ? 'check' : 'content_copy'} size={16} className={copied ? 'text-success' : ''} />
        {copied ? 'Copied' : label}
      </button>
    )
  }
  return (
    <button
      onClick={(e) => {
        e.stopPropagation() // don't trigger a highlight-row jump when copying
        copy()
      }}
      className="press grid h-8 w-8 shrink-0 place-items-center rounded-lg text-secondary hover:bg-surface-container hover:text-primary"
      aria-label="Copy"
    >
      <Icon name={copied ? 'check' : 'content_copy'} size={17} className={copied ? 'text-success' : ''} />
    </button>
  )
}

// ── Processing pipeline (non-ready episodes) ─────────────────────────────────
const PIPELINE: { status: ProcessingStatus; label: string; icon: string }[] = [
  { status: 'detected', label: 'Episode detected', icon: 'fiber_new' },
  { status: 'fetching', label: 'Fetching audio', icon: 'downloading' },
  { status: 'transcribing', label: 'Transcribing', icon: 'graphic_eq' },
  { status: 'summarizing', label: 'Generating AI summary', icon: 'auto_awesome' },
  { status: 'ready', label: 'Summary ready', icon: 'check_circle' },
]
const PIPELINE_N = PIPELINE.length
const PIPELINE_SEG = 1 / (PIPELINE_N - 1) // fraction of the bar between two adjacent steps

type PipeMode = 'processing' | 'ready' | 'failed' | 'pending'
type NodeState = 'done' | 'active' | 'pending' | 'error'

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

function usePrefersReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)'
  const [reduce, setReduce] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches)
  useEffect(() => {
    const mq = window.matchMedia?.(query)
    if (!mq) return
    const onChange = () => setReduce(mq.matches)
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])
  return reduce
}

// A single determinate progress value (0–1) for the whole panel. It sweeps up to
// the active stage, then *trickles* toward — but never reaches — the next step so
// a long-running stage (the LLM writing the summary) keeps inching instead of
// sitting frozen. Each step advance eases it onward; "ready" snaps it home. The
// CSS width/height transitions smooth the discrete updates into continuous glide.
function usePipelineProgress(idx: number, mode: PipeMode): number {
  const base = Math.max(0, idx) * PIPELINE_SEG
  const reduce = usePrefersReducedMotion()
  const [p, setP] = useState(mode === 'ready' ? 1 : 0)

  useEffect(() => {
    if (mode === 'ready') return setP(1)
    if (mode === 'failed') return setP(base)
    if (mode === 'pending') return setP(0)
    if (reduce) return setP(Math.min(base + PIPELINE_SEG * 0.5, 0.985))

    const id = setInterval(() => {
      setP((prev) => {
        // Ceiling sits just below the next node so the % never rounds to 100 while
        // working, and the connector keeps its leading-edge glow (fill < 0.99).
        const cap = Math.min(base + PIPELINE_SEG * 0.96, 0.99)
        if (prev >= cap) return cap
        // Quick sweep up to the stage we're on, snapping on at the end so we cross
        // into the creep band (also re-runs when a step advances and `base` jumps).
        if (prev < base) {
          const next = prev + (base - prev) * 0.3
          return next >= base - 0.004 ? base : next
        }
        // Within-stage creep: a shrinking-but-floored step toward the ceiling, so it
        // slows as it climbs but never stops — a long stage keeps inching forward
        // instead of parking at one number.
        const step = Math.max((cap - prev) * 0.018, 0.0006) // ~0.3%/s floor near the top
        return Math.min(prev + step, cap)
      })
    }, 200)
    return () => clearInterval(id)
  }, [idx, mode, base, reduce])

  return p
}

function ProcessingPanel({ episode, onRetry, needsApiKey }: { episode: Episode; onRetry?: () => void; needsApiKey?: boolean }) {
  const status = episode.status
  const failed = status === 'failed'
  const ready = status === 'ready'
  const mode: PipeMode = failed ? 'failed' : ready ? 'ready' : needsApiKey ? 'pending' : 'processing'
  const rawIndex = PIPELINE.findIndex((p) => p.status === status)
  const idx = failed ? 1 : rawIndex < 0 ? 0 : rawIndex
  const progress = usePipelineProgress(idx, mode)
  const meta = statusMeta(status)

  const nodeState = (i: number): NodeState => {
    if (failed) return i < idx ? 'done' : i === idx ? 'error' : 'pending'
    if (ready) return 'done'
    if (needsApiKey) return i === 0 ? 'active' : 'pending'
    return i < idx ? 'done' : i === idx ? 'active' : 'pending'
  }

  return (
    <section className="mx-auto max-w-reading rounded-2xl border border-outline-variant bg-surface-container-lowest p-lg shadow-card">
      <div className="mb-lg flex items-center gap-sm">
        <span className="grid h-10 w-10 place-items-center rounded-full chip-signal">
          <Icon
            name={failed ? 'error' : meta.icon}
            className={`${failed ? 'text-error' : ''} ${mode === 'processing' ? 'motion-safe:animate-spin' : ''}`}
          />
        </span>
        <div>
          <h2 className="text-[19px] font-semibold text-on-surface">
            {failed ? 'Processing failed' : needsApiKey ? 'Summary pending' : ready ? 'Summary ready' : 'Working on this episode…'}
          </h2>
          <p className="text-metadata text-secondary">
            {failed
              ? 'Something went wrong during processing. You can retry the pipeline.'
              : needsApiKey
                ? 'Add an OpenAI or Anthropic API key (in your local .env, or the Pages env vars) to generate the AI summary from this episode’s show-notes.'
                : 'Munshot is reading the show-notes and writing the AI summary. It will appear here when ready.'}
          </p>
        </div>
      </div>

      {mode !== 'pending' && <PipelineBar progress={progress} mode={mode} idx={idx} />}

      <ol className="relative">
        {PIPELINE.map((step, i) => {
          const state = nodeState(i)
          const last = i === PIPELINE_N - 1
          // How far the moving front has travelled through the connector below
          // this node, derived from the one shared progress value.
          const fill = clamp((progress - i * PIPELINE_SEG) / PIPELINE_SEG, 0, 1)
          return (
            <li key={step.status} className="flex gap-md">
              <div className="flex flex-col items-center">
                <StepNode state={state} icon={step.icon} live={mode === 'processing'} />
                {!last && <StepConnector fill={fill} active={state === 'active' && mode === 'processing'} />}
              </div>
              <div className="flex h-6 flex-1 items-center justify-between">
                <p className={`text-body-md transition-colors ${state === 'done' || state === 'active' ? 'font-semibold text-on-surface' : 'text-secondary'}`}>
                  {step.label}
                </p>
                {state === 'active' && mode === 'processing' && (
                  <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-primary">
                    <span className="h-1.5 w-1.5 rounded-full bg-primary motion-safe:animate-pulse" /> In progress
                  </span>
                )}
                {state === 'error' && <span className="text-[12px] font-medium text-error">Failed</span>}
                {state === 'done' && <Icon name="check" size={16} className="text-primary/60" />}
              </div>
            </li>
          )
        })}
      </ol>

      {failed && onRetry && (
        <button
          onClick={onRetry}
          className="press mt-md inline-flex items-center gap-2 rounded-lg bg-primary px-lg py-2.5 text-metadata font-semibold text-on-primary hover:bg-primary-container"
        >
          <Icon name="refresh" size={18} /> Retry processing
        </button>
      )}
    </section>
  )
}

// Headline horizontal progress bar — the at-a-glance "how far along" read, with a
// sheen sweeping the fill while work is live so it never looks stuck.
function PipelineBar({ progress, mode, idx }: { progress: number; mode: PipeMode; idx: number }) {
  const pct = Math.round(progress * 100)
  const tone =
    mode === 'failed'
      ? 'from-error to-[#f06565]'
      : mode === 'ready'
        ? 'from-success to-[#34d27b]'
        : 'from-primary to-[#4f86f7]'
  const pctTone = mode === 'failed' ? 'text-error' : mode === 'ready' ? 'text-success' : 'text-primary'
  return (
    <div className="mb-lg">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-metadata font-medium text-secondary">
          {mode === 'ready' ? 'Complete' : `Step ${Math.min(idx + 1, PIPELINE_N)} of ${PIPELINE_N} · ${PIPELINE[idx].label}`}
        </span>
        <span className={`text-metadata font-bold tabular-nums ${pctTone}`}>{pct}%</span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label="Episode processing progress"
        className="relative h-2 overflow-hidden rounded-full bg-surface-container-high"
      >
        <div
          className={`relative h-full rounded-full bg-gradient-to-r ${tone}`}
          style={{ width: `${progress * 100}%`, transition: 'width 380ms var(--ease-out)' }}
        >
          {mode === 'processing' && <span className="pipe-sheen" aria-hidden />}
        </div>
      </div>
    </div>
  )
}

// The circular step marker. The in-progress stage gets a rotating spinner ring
// and a pulsing halo; a node "pops" the moment the front passes it into done.
function StepNode({ state, icon, live }: { state: NodeState; icon: string; live: boolean }) {
  const ring =
    state === 'done'
      ? 'border-primary bg-primary text-on-primary'
      : state === 'active'
        ? 'border-primary bg-surface text-primary'
        : state === 'error'
          ? 'border-error bg-error-container text-on-error-container'
          : 'border-outline-variant bg-surface text-outline'
  const glyph = state === 'done' ? 'check' : state === 'error' ? 'priority_high' : icon
  const spinning = state === 'active' && live
  return (
    <span className="relative grid h-6 w-6 shrink-0 place-items-center">
      {spinning && (
        <span className="absolute -inset-[3px] rounded-full border-2 border-primary/25 border-t-primary motion-safe:animate-spin" aria-hidden />
      )}
      <span className={`relative grid h-6 w-6 place-items-center rounded-full border-2 transition-colors ${ring} ${spinning ? 'node-halo' : ''}`}>
        <Icon key={state} name={glyph} size={14} className={state === 'done' || state === 'error' ? 'node-pop' : ''} />
      </span>
    </span>
  )
}

// The rail segment between two nodes. The blue fill grows from the top toward the
// next step; the active segment flows + glows at its leading edge so the eye is
// drawn to exactly where the work is right now.
function StepConnector({ fill, active }: { fill: number; active: boolean }) {
  return (
    <div className="relative my-1 h-7 w-[3px] overflow-hidden rounded-full bg-surface-container-high">
      <div
        className={`absolute inset-x-0 top-0 rounded-full ${active ? 'pipe-wire' : 'bg-gradient-to-b from-primary to-[#4f86f7]'}`}
        style={{ height: `${fill * 100}%`, transition: 'height 380ms var(--ease-out)' }}
      >
        {active && fill > 0.02 && fill < 0.99 && <span className="pipe-glow" aria-hidden />}
      </div>
    </div>
  )
}
