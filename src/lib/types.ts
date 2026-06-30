// ─────────────────────────────────────────────────────────────────────────────
// Munshot Podcasts domain model
// These types are the contract between the UI and the (future) backend. The
// mock api in `api.ts` returns exactly these shapes, so swapping mock data for
// real `fetch()` calls is a drop-in change.
// ─────────────────────────────────────────────────────────────────────────────

/** The lifecycle a detected episode moves through before it's readable. */
export type ProcessingStatus =
  | 'detected' // new episode found on a tracked feed
  | 'fetching' // pulling the audio / video
  | 'transcribing' // sent to the transcription API
  | 'summarizing' // running the AI summary pass
  | 'ready' // one-page summary available
  | 'failed' // something broke; needs a retry

export type SourceKind = 'podcast' | 'youtube'

export interface Podcast {
  id: string
  title: string
  author: string
  category: string
  description: string
  /** Human cadence, e.g. "Weekly", "2–3 / week". */
  cadence: string
  episodeCount: number
  source: SourceKind
  /** Brand color + monogram drive the generated cover tile (no external images). */
  color: string
  monogram: string
  /** Real cover art (square). When absent, the UI falls back to color + monogram. */
  artworkUrl?: string
  /** Canonical RSS/Atom feed. Set for user-added shows (carried from search so
   *  their episodes can be detected); seed shows keep their feeds server-side. */
  feedUrl?: string
  tracked: boolean
  /** No public feed → episodes can't be ingested or transcribed. Rendered as a
   *  locked show; its episodes are suppressed so users never see fabricated data. */
  locked?: boolean
}

/** A directory search hit (Apple Podcasts / resolved RSS / YouTube channel).
 *  Mirrors the server's `PodcastSearchResult` (server/search.ts) — the wire shape
 *  the /api/search-podcasts endpoint returns. */
export interface PodcastSearchResult {
  id: string
  title: string
  author: string
  category: string
  description: string
  artworkUrl?: string
  feedUrl: string
  source: SourceKind
}

/** A plain conclusion — title + supporting detail. Used by the weekly digest,
 *  where points synthesise across episodes and have no single timestamp. */
export interface Takeaway {
  title: string
  detail: string
}

/** An episode highlight — the merged "takeaway + interesting moment": one beat
 *  worth revisiting, anchored to where in the episode it happens. */
export interface Highlight extends Takeaway {
  id: string
  timestamp: string // "45:12", or "—" when unknown (show-notes-only summaries)
  /** Links to a transcript segment so a click can jump straight to it. */
  segmentId?: string
  /** Flagged by the AI as one of the few most important — the key takeaways. */
  key?: boolean
}

export interface QAItem {
  q: string
  a: string
}

/** A concrete, actionable idea pitched in an episode — an investment/stock pick,
 *  a trade, a macro call, or a bold specific prediction — with the thesis behind
 *  it. The unit that lets the weekly surface "what was actually pitched" instead
 *  of dissolving it into generic themes. */
export interface Idea {
  /** The specific call, naming the instrument/company/action — e.g. "Long Uber (UBER)",
   *  "Short commercial real estate", "Fed cuts twice in 2026". */
  idea: string
  /** Who pitched it (speaker), or "—" when unattributed. */
  proponent: string
  /** The 2-4 key supporting thesis points, each a concrete clause. */
  thesis: string[]
  /** Optional coarse tag driving a subtle badge in the UI. */
  kind?: 'stock' | 'trade' | 'macro' | 'prediction'
}

export interface TranscriptSegment {
  id: string
  speaker: string
  role: 'host' | 'guest'
  timestamp: string
  text: string
  /** When set, this segment contains a highlighted span tied to a summary module. */
  highlight?: {
    /** Matches a Highlight.id. */
    refId: string
    /** The exact substring of `text` to wrap in a <mark>. */
    quote: string
    label: string
  }
}

export type ToneSentiment = 'positive' | 'negative' | 'neutral'

/** One thing the episode actually discusses, with the sentiment expressed toward it. */
export interface ToneAspect {
  /** A real company / person / topic, e.g. "SpaceX", "secondary markets". */
  subject: string
  sentiment: ToneSentiment
  /** Short, specific reason drawn from the material. */
  note: string
}

/** A context-aware tone read produced by the summarizer LLM (not the lexicon). */
export interface EpisodeTone {
  // Intentionally mirrors `ToneLabel` (src/lib/tone.ts) WITHOUT importing it — tone.ts
  // imports this module, so importing back would be a circular dependency.
  overall: 'positive' | 'cautious' | 'mixed' | 'neutral'
  /** ONE sentence explaining the net read, grounded in the episode. */
  rationale: string
  /** 3-6 aspects — the "about what" behind the net read. */
  aspects: ToneAspect[]
}

/** One hard number actually stated in the material — the unit behind the
 *  Quantitative Summary table (Metric / Value / Context). Numbers are quoted
 *  EXACTLY as said (unit/qualifier kept); never invented, rounded-to-invent, or
 *  inferred. */
export interface QuantPoint {
  /** What the number measures, e.g. "Amazon DSP spend", "Truckload pricing". */
  metric: string
  /** The value exactly as stated, e.g. "$50M in first 5 months of 2026", "up 20-30%". */
  value: string
  /** The source/comparison that makes the number meaningful, e.g. "vs $11.5M a year prior". */
  context: string
}

/** A named party an episode's development moves — a company / person / asset /
 *  cohort, with the SPECIFIC mechanism. Drives the "who benefits / who's at risk"
 *  read. */
export interface InsightParty {
  /** The specific name (include a ticker when stated), e.g. "Old Dominion (ODFL)". */
  name: string
  /** The concrete mechanism, e.g. "share gainer on service reputation + low purchased-transport reliance". */
  why: string
}

/** The investable read of an episode — the five-part lens an analyst applies:
 *  what changed, why it matters, who benefits, who is at risk, and what to dig
 *  into next. Grounded strictly in the material; arrays are EMPTY (never padded)
 *  when the episode names no party / raises no question. */
export interface EpisodeInsight {
  /** The single most important NEW development or shift — the concrete fact. */
  whatChanged: string
  /** The second-order, investable consequence and who it moves. */
  whyItMatters: string
  /** Named winners + the mechanism. Empty when none is named. */
  beneficiaries: InsightParty[]
  /** Named losers + the mechanism. Empty when none is named. */
  atRisk: InsightParty[]
  /** 2-5 forward-looking, checkable research questions that would confirm or kill
   *  the thesis — NOT a restatement of the episode's own Q&A. Empty when none. */
  diligenceQuestions: string[]
}

/** The one-page AI summary — everything a single episode produces. */
export interface Summary {
  /** The readable one-page synthesis, as paragraphs. */
  synthesis: string[]
  /** Timestamped highlights in timeline order; the `key` ones are the headline takeaways. */
  highlights: Highlight[]
  qa: QAItem[]
  /** Concrete ideas pitched in the episode (stock/macro/trade calls + thesis).
   *  Optional: empty/absent when the episode pitches nothing specific, and older
   *  cached summaries predate the field. */
  ideas?: Idea[]
  /** Context-aware tone read from the summarizer LLM. Optional: older cached
   *  summaries (and mock data) predate it and fall back to the lexicon roll-up. */
  tone?: EpisodeTone
  /** The investable read — what changed / why it matters / who benefits / who's
   *  at risk / diligence questions. Optional: older cached summaries (pre-r7) and
   *  mock data predate it; renderers guard with `?.`. */
  insight?: EpisodeInsight
  /** Hard numbers stated in the episode — the feed for the Quantitative Summary
   *  table (per-episode + aggregated into the weekly). Optional/empty when the
   *  episode states no figures. */
  quantData?: QuantPoint[]
}

export interface EpisodeEntities {
  people: string[]
  companies: string[]
  themes: string[]
}

export interface Episode {
  id: string
  podcastId: string
  title: string
  publishedAt: string // ISO date
  durationSec: number
  status: ProcessingStatus
  signal: 'high' | 'normal'
  /** One-line teaser shown in lists and the hero card. */
  blurb: string
  /** Deep link to the episode at its origin (Apple Podcasts, YouTube, RSS). When absent, the UI falls back to a source search. */
  sourceUrl?: string
  /** Publisher show-notes (trimmed) — fallback material for the AI summary when no transcript exists. */
  notes?: string
  /** Publisher-provided transcript file (SRT/VTT) from the feed, when available — preferred summary source. */
  transcriptUrl?: string
  /** Audio enclosure URL — source for Whisper transcription (paid/free-tier providers). */
  audioUrl?: string
  entities: EpisodeEntities
  /** Present once status === 'ready'. */
  summary?: Summary
  transcript?: TranscriptSegment[]
}

/** A pitched idea as it appears in the weekly digest — the episode `Idea` plus a
 *  link back to the source episode (the show is implied by its parent digest). */
export interface WeeklyIdea extends Idea {
  episodeId: string
}

/** One show's slice of the week — the per-show mini-digest that is the weekly's
 *  primary organizing principle: what this show pitched, concluded, and left open. */
export interface WeeklyShowDigest {
  show: string
  podcastId: string
  episodeIds: string[]
  episodeCount: number
  ideas: WeeklyIdea[]
  takeaways: Takeaway[]
  questions: string[]
}

/** A thematic Key-Points cluster in the weekly — the Guidepoint "Key Points"
 *  unit. `points` are claim-first bullets ("**claim**: specifics [n]"), grouped
 *  by THEME across episodes (not per-show). */
export interface WeeklyTheme {
  heading: string
  points: string[]
}

/** @deprecated Replaced by `WeeklyEpisodeReadout` (the Investment Readout). Kept so
 *  older cached editions in localStorage/KV still parse; no longer emitted/rendered. */
export interface WeeklyComparisonRow {
  index: number
  source: string // show — episode title
  speaker: string // lead voice, or "—"
  date: string
  keyPoints: string
  /** Resolved during merge so the renderer can link the row to its episode. */
  episodeId?: string
}

/** One episode's INVESTMENT READOUT — the unit of the weekly "investment intelligence
 *  note". Strictly separates what the podcast SAID (`evidence`) from the model's
 *  INFERENCE (`interpretation`), with the external checks (`questionsToVerify`), the
 *  next `action`, and a `confidence` grade. `index` is the citation `[n]`; `episodeId`
 *  is resolved during merge so renderers can link the row/card to its episode. */
export interface WeeklyEpisodeReadout {
  index: number
  episodeId?: string
  /** Short recognizable episode label for the table's "Episode" cell, e.g. "Holcim CEO". */
  episode: string
  /** The single investable theme this episode surfaces. */
  theme: string
  /** Podcast Evidence — facts/numbers/quotes ONLY present in the source material. */
  evidence: string
  /** Investment Interpretation — the model's inference, framed as a hypothesis. */
  interpretation: string
  /** Named companies/tickers + sectors implicated; "—" when none named. */
  namesSectors: string
  confidence: 'Low' | 'Medium' | 'High'
  /** What to check next (evidence + explicitly-stated assumptions). */
  action: string
  /** Forward-looking EXTERNAL checks that would confirm or kill the interpretation. */
  questionsToVerify: string[]
}

/** The `[n]` → episode registry that backs every inline citation in the weekly. */
export interface WeeklyCitation {
  index: number
  episodeId: string
  label: string // "Show — Episode title"
}

/** One episode rendered as a numbered source for the weekly synthesis prompt —
 *  the per-episode insight flattened into the LLM's input so it can synthesize
 *  ACROSS sources and cite them by `[index]`. */
export interface WeeklySource {
  index: number
  show: string
  title: string
  date: string
  speaker: string
  whatChanged?: string
  whyItMatters?: string
  beneficiaries?: string
  atRisk?: string
  quant?: string
  keyPoints?: string
  /** The episode's forward-looking diligence questions — seeds "questions to verify". */
  diligence?: string
  /** The episode's lead synthesis paragraph — its central argument, as grounded evidence. */
  synthesis?: string
}

/** The cross-episode narrative the weekly synthesis LLM produces (the layer on
 *  top of the deterministic base). Citations use `[n]` against the source order. */
export interface WeeklyAi {
  overview: string[]
  keyThemes: WeeklyTheme[]
  quantTable: QuantPoint[]
  /** Per-episode Investment Readout (replaces the old comparison table). */
  episodeReadouts: WeeklyEpisodeReadout[]
  questions: string[]
}

/** The day/time/timezone the weekly digest is mailed. Chosen in the app, stored
 *  server-side, and enforced by the cron endpoint (server/scheduleStore.ts). */
export interface WeeklySchedule {
  /** 0 = Sunday … 6 = Saturday (JS getDay convention). */
  dayOfWeek: number
  /** Local hour, 0–23. */
  hour: number
  /** Local minute, 0–59. */
  minute: number
  /** IANA timezone, e.g. "Asia/Kolkata". */
  timezone: string
}

export interface WeeklySummary {
  id: string
  rangeLabel: string // "May 19 – May 25, 2026"
  episodeCount: number
  readMinutes: number
  /** "This week in summary" prose — synthesized, with inline `[n]` citations. */
  overview: string[]
  /** The Guidepoint "Key Points" — thematic, claim-first, cross-episode. The
   *  PRIMARY body when present; falls back to `shows` (by-show) when absent. */
  keyThemes?: WeeklyTheme[]
  /** Aggregated hard numbers — the Quantitative Summary table. */
  quantTable?: QuantPoint[]
  /** Per-episode Investment Readout — the table + cards. */
  episodeReadouts?: WeeklyEpisodeReadout[]
  /** @deprecated Superseded by `episodeReadouts`; retained for back-compat with cached editions. */
  comparison?: WeeklyComparisonRow[]
  /** The `[n]` → episode registry backing the citations in overview/keyThemes. */
  citations?: WeeklyCitation[]
  /** The week organized by show — secondary appendix (and the no-AI fallback body). */
  shows: WeeklyShowDigest[]
  topThemes: { label: string; momentum: number }[]
  /** "What was actually interesting" — a curated moment: a headline + the insight. */
  interesting: { title: string; quote: string; speaker: string; role: string; episodeId: string }
  /** Cross-show fallback takeaways (rendering is per-show via `shows`; kept for the
   *  deterministic/no-key path and older consumers). */
  takeaways: Takeaway[]
  contradictions: string[]
  mentions: { people: string[]; companies: string[] }
  questions: string[]
  sourceEpisodeIds: string[]
}

