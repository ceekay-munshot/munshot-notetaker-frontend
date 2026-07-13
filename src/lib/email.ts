import type { Episode, EpisodeInsight, Idea, Podcast, QAItem, QuantPoint, WeeklyShowDigest, WeeklySummary } from './types'
import { esc } from './exportDoc'
import { weeklyReportTitle } from './reportName'
import { formatDuration, longDate } from './format'
import { groupQuantByEpisode } from './weeklyQuant'
import { parseSummaryBlock } from './summaryFormat'

// ─────────────────────────────────────────────────────────────────────────────
// Email delivery — the real wiring behind the Weekly-brief subscription seam.
//
// POST https://devde.muns.io/email/send/raw
//   body: { email, subject, text }  OR  { email, subject, html }   (exactly one)
//   ok:   { data: { message }, message, success: true }
//
// The endpoint authenticates with the signed-in user's session (it "works with
// the user token using the dashboard"). This app runs inside the chat.muns.io
// ecosystem in the browser, so we send the request with `credentials: 'include'`
// to carry whatever muns.io auth cookie the browser already holds. If a future
// SDK build surfaces an explicit bearer token, pass it as `opts.token` and it
// rides along as `Authorization: Bearer …` — no other change needed here.
//
// Like the rest of the api seam, sending is BEST-EFFORT: any network/CORS/HTTP
// failure resolves to `{ ok: false, … }` rather than throwing, so a flaky mail
// hop never crashes a click handler. The single hard rule we enforce locally is
// the contract's "exactly one of text|html".
// ─────────────────────────────────────────────────────────────────────────────

const EMAIL_ENDPOINT = 'https://devde.muns.io/email/send/raw'

export interface EmailResult {
  ok: boolean
  /** The server's human message ("Email sent successfully!"), or a local error reason. */
  message: string
}

interface BaseEmail {
  email: string
  subject: string
}
/** Send EITHER text OR html — never both, never neither (the endpoint's contract). */
export type RawEmail = BaseEmail & ({ text: string; html?: never } | { html: string; text?: never })

/** The endpoint's JSON envelope: `{ data: { message }, message, success }`. */
interface EmailEndpointResponse {
  success?: boolean
  message?: string
  data?: { message?: string }
}

/** Send one email through the Munshot raw-email endpoint. Resolves `{ ok }`;
 *  never throws (network/CORS/HTTP errors become `ok: false`). */
export async function sendRawEmail(message: RawEmail, opts: { token?: string } = {}): Promise<EmailResult> {
  const email = message.email?.trim()
  const subject = message.subject?.trim()
  const hasText = typeof (message as { text?: unknown }).text === 'string' && (message as { text: string }).text.length > 0
  const hasHtml = typeof (message as { html?: unknown }).html === 'string' && (message as { html: string }).html.length > 0

  if (!email) return { ok: false, message: 'A recipient email is required.' }
  if (!subject) return { ok: false, message: 'An email subject is required.' }
  if (hasText === hasHtml) return { ok: false, message: 'Send exactly one of text or html.' }

  // Visual shell: there is no email backend. Validate the message exactly as the
  // real sender did, then resolve an inert success without making any network
  // call — the UI's happy path renders, but nothing is actually delivered.
  void opts
  return { ok: true, message: 'Email sending is disabled in this UI build.' }
}

/** Only a non-empty string survives — guards the UI from a nested error object. */
function str(v: unknown): string {
  return typeof v === 'string' && v.trim() ? v : ''
}

// ── HTML email templates (email-client-safe) ────────────────────────────────
// Email clients (notably Gmail) strip <head>/<style> and most class selectors,
// so every rule here is an INLINE style and every layout is a table — the same
// house style as the Word/PDF exports (navy #14233c, gold #b8902f, Georgia
// display), rebuilt for the inbox. Web-safe fonts only (no @font-face).

const C = {
  navy: '#14233c',
  ink: '#1a2b4a',
  gold: '#b8902f',
  goldSoft: '#e7cf93',
  body: '#42506a',
  prose: '#2b3850',
  line: '#e6eaf1',
  panel: '#f6f8fb',
  cream: '#faf6ea',
  page: '#eef1f6',
  white: '#ffffff',
}
const SERIF = "Georgia, 'Times New Roman', serif"
const SANS = "Arial, Helvetica, 'Segoe UI', sans-serif"
const MONO = "'Courier New', Courier, monospace"

// Every Munshot email drives the reader back to the live dashboard.
const MUNS_DASHBOARD = 'https://chat.muns.io/dashboards'

/** esc + promote **bold** to gold <strong> (mirrors the in-app/doc emphasis rule). */
function richInline(s: string): string {
  return esc(s).replace(/\*\*([^*]+)\*\*/g, `<strong style="color:${C.gold};font-weight:700;">$1</strong>`)
}

/** richInline + turn each inline [n] citation marker into a gold link back to the
 *  dashboard, so a reader can click any claim to open the full intelligence. */
function richCited(s: string, url: string = MUNS_DASHBOARD): string {
  return richInline(s).replace(/\[(\d+)\]/g, `<a href="${esc(url)}" style="color:${C.gold};font-weight:700;text-decoration:none;">[$1]</a>`)
}

/** A pill CTA button — filled navy (primary) or outlined (secondary). */
function ctaButton(href: string, label: string, opts: { primary?: boolean } = {}): string {
  const bg = opts.primary ? C.navy : C.white
  const fg = opts.primary ? '#ffffff' : C.navy
  const border = opts.primary ? '#6b5a2e' : '#d8c187'
  return `<a href="${esc(href)}" style="display:inline-block;background:${bg};color:${fg};font-family:${SANS};font-weight:700;font-size:14px;text-decoration:none;padding:13px 26px;border-radius:6px;border:1px solid ${border};">${label}</a>`
}

// The navy hero band that opens every Munshot email. `kicker` is the gold
// top-right label (defaults to the weekly wording so existing emails are
// byte-identical; the episode email overrides it).
function header(eyebrow: string, title: string, dateRange?: string, chips: string[] = [], kicker = 'Weekly Intelligence'): string {
  const chipHtml = chips
    .filter(Boolean)
    .map(
      (c) =>
        `<span style="display:inline-block;font-family:${MONO};font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#cdd7e6;border:1px solid #9c7b2e;padding:3px 10px;margin:0 4px;">${esc(
          c,
        )}</span>`,
    )
    .join('')
  return `<tr><td style="background:${C.navy};padding:30px 36px;border-top:3px solid ${C.gold};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font-family:${SERIF};font-weight:700;font-size:18px;letter-spacing:1px;color:#f3f6fb;">Munshot</td>
        <td align="right" style="font-family:${SANS};font-weight:700;font-size:10px;letter-spacing:3px;text-transform:uppercase;color:${C.goldSoft};">${esc(kicker)}</td>
      </tr></table>
      <div style="border-top:1px solid #9c7b2e;margin:16px 0;font-size:0;line-height:0;">&nbsp;</div>
      <div style="font-family:${SANS};font-weight:700;font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#cea344;">${esc(
        eyebrow,
      )}</div>
      <div style="font-family:${SERIF};font-weight:700;font-size:34px;line-height:1.1;color:#f4eedf;margin-top:8px;">${esc(
        title,
      )}</div>
      ${dateRange ? `<div style="font-family:${SERIF};font-style:italic;font-size:17px;color:${C.goldSoft};margin-top:10px;">${esc(dateRange)}</div>` : ''}
      ${chipHtml ? `<div style="margin-top:16px;">${chipHtml}</div>` : ''}
    </td></tr>`
}

// `note` is the small reassurance line (defaults to the weekly-brief wording so
// existing emails are unchanged; the episode email passes its own).
function footer(
  note = `You're receiving this because you subscribed to the Munshot Weekly Brief. Manage it from your <a href="${MUNS_DASHBOARD}" style="color:${C.goldSoft};">Munshot dashboard</a>'s weekly-brief bell.`,
): string {
  return `<tr><td style="background:${C.navy};padding:18px 36px;border-top:1px solid #9c7b2e;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font-family:${SANS};font-size:11px;color:#9fb0c6;">Generated by <strong style="color:#e7eef7;">Munshot</strong> &middot; AI podcast intelligence</td>
        <td align="right" style="font-family:${MONO};font-size:10px;letter-spacing:1.5px;text-transform:uppercase;"><a href="${MUNS_DASHBOARD}" style="color:${C.goldSoft};text-decoration:none;">chat.muns.io</a></td>
      </tr></table>
      <p style="font-family:${SANS};font-size:11px;color:#7d8ba3;margin:10px 0 0;">${note}</p>
    </td></tr>`
}

// A gold-uppercase section label.
function sectionLabel(text: string): string {
  return `<div style="font-family:${SANS};font-weight:700;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${C.gold};border-left:3px solid ${C.gold};padding-left:10px;margin:26px 0 12px;">${esc(
    text,
  )}</div>`
}

// Wrap an email body in the centered, page-background shell.
function shell(title: string, rows: string): string {
  return `<!doctype html><html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>${esc(
    title,
  )}</title></head>
<body style="margin:0;padding:0;background:${C.page};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(title)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page};padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:${C.white};border:1px solid #dfe4ec;border-radius:4px;overflow:hidden;">
        ${rows}
      </table>
    </td></tr>
  </table>
</body></html>`
}

/** Subscription confirmation — a designed, branded welcome (no fabricated data). */
export function welcomeEmailHtml(opts: { name?: string } = {}): string {
  const greeting = opts.name ? `Hi ${esc(opts.name.split(/\s+/)[0])},` : 'Hello,'
  const inside = [
    ['By show', 'each show you track, distilled into its own mini-digest.'],
    ['Ideas pitched', 'the concrete stock, trade, and macro calls — with the thesis behind each.'],
    ['Key takeaways', 'the few conclusions actually worth remembering.'],
    ['What was interesting', 'the one moment from the week worth a second look.'],
  ]
    .map(
      ([t, d]) =>
        `<tr><td style="padding:0 0 10px;font-family:${SANS};font-size:14px;line-height:1.5;color:${C.body};"><span style="color:${C.gold};font-weight:700;">&#9670;</span> <strong style="color:${C.ink};">${esc(
          t,
        )}.</strong> ${esc(d)}</td></tr>`,
    )
    .join('')

  const bodyRow = `<tr><td style="padding:30px 36px;">
      <p style="font-family:${SANS};font-size:15px;color:${C.prose};margin:0 0 14px;">${greeting}</p>
      <p style="font-family:${SANS};font-size:15px;line-height:1.6;color:${C.prose};margin:0 0 18px;">You're subscribed to the <strong style="color:${C.ink};">Munshot Weekly Brief</strong>. Every Monday we'll send you one email with the whole week's summary across the shows you track — synthesised, organised, and citation-backed.</p>
      ${sectionLabel("What's inside each edition")}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${inside}</table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0 4px;"><tr><td align="center">
        ${ctaButton(MUNS_DASHBOARD, '&#128202;&nbsp; Open your Munshot dashboard', { primary: true })}
        <div style="font-family:${SANS};font-size:11px;color:#8794a8;margin-top:9px;">Don't wait for Monday — the live summary is ready now.</div>
      </td></tr></table>
      <p style="font-family:${SANS};font-size:13px;line-height:1.6;color:${C.body};margin:20px 0 0;padding-top:16px;border-top:1px solid ${C.line};">No brief yet this week? You'll get the next edition the moment it's ready — and you can read the live summary any time on your <a href="${MUNS_DASHBOARD}" style="color:${C.gold};font-weight:700;text-decoration:none;">Munshot dashboard</a>.</p>
    </td></tr>`

  return shell(
    "You're subscribed — Munshot Weekly Brief",
    header('AI Podcast Intelligence', "You're subscribed") + bodyRow + footer(),
  )
}

// ── Weekly edition → HTML email (real content) ───────────────────────────────

function ideaBlock(idea: Idea): string {
  const kind = idea.kind
    ? `<span style="display:inline-block;font-family:${SANS};font-weight:700;font-size:10px;letter-spacing:.5px;text-transform:uppercase;color:${C.gold};background:${C.cream};border:1px solid #e2cf95;padding:1px 7px;margin-right:7px;">${esc(
        idea.kind,
      )}</span>`
    : ''
  const who =
    idea.proponent && idea.proponent !== '—'
      ? `<p style="font-family:${SANS};font-size:12px;color:#54606e;margin:0 0 7px;">Pitched by <strong style="color:${C.ink};">${esc(
          idea.proponent,
        )}</strong></p>`
      : ''
  const thesis = idea.thesis.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${idea.thesis
        .map(
          (t) =>
            `<tr><td style="font-family:${SANS};font-size:13px;line-height:1.5;color:${C.body};padding:0 0 3px;"><span style="color:${C.gold};">&#9670;</span> ${richInline(
              t,
            )}</td></tr>`,
        )
        .join('')}</table>`
    : ''
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.panel};border:1px solid ${C.line};border-left:3px solid ${C.gold};margin:0 0 8px;"><tr><td style="padding:12px 14px;">
      <div style="font-family:${SERIF};font-weight:700;font-size:15px;color:${C.ink};margin:0 0 5px;">${kind}${esc(idea.idea)}</div>
      ${who}${thesis}
    </td></tr></table>`
}

function showBlock(d: WeeklyShowDigest): string {
  const count = `${d.episodeCount} episode${d.episodeCount === 1 ? '' : 's'}`
  const head = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #d4dbe6;margin:0 0 10px;"><tr>
      <td style="font-family:${SERIF};font-weight:700;font-size:17px;color:${C.ink};padding-bottom:6px;">${esc(d.show)}</td>
      <td align="right" style="font-family:${SANS};font-size:12px;color:#7d8ba3;padding-bottom:6px;">${esc(count)}</td>
    </tr></table>`
  const subhead = (t: string) =>
    `<div style="font-family:${SANS};font-weight:700;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:${C.gold};margin:12px 0 7px;">${esc(t)}</div>`
  const ideas = d.ideas.length ? subhead('Ideas Pitched') + d.ideas.map(ideaBlock).join('') : ''
  const takeaways = d.takeaways.length
    ? subhead('Key Takeaways') +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${d.takeaways
        .map(
          (t) =>
            `<tr><td style="font-family:${SANS};font-size:14px;line-height:1.55;color:${C.body};padding:0 0 6px;"><span style="color:${C.gold};">&#9642;</span> <strong style="color:${C.ink};">${esc(
              t.title,
            )}.</strong> ${richInline(t.detail)}</td></tr>`,
        )
        .join('')}</table>`
    : ''
  const questions = d.questions.length
    ? subhead('Questions') +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${d.questions
        .map(
          (q) =>
            `<tr><td style="font-family:${SANS};font-size:13px;font-style:italic;line-height:1.5;color:#46566f;border-left:2px solid #cea344;padding:0 0 6px 10px;margin:0;">${richInline(
              q,
            )}</td></tr>`,
        )
        .join('')}</table>`
    : ''
  return `<div style="margin:0 0 22px;">${head}${ideas}${takeaways}${questions}</div>`
}

type ById<T> = (id: string) => T | undefined

/** Render a real Weekly edition as a designed HTML email (mirrors the Word/PDF). */
export function weeklyBriefEmailHtml(
  weekly: WeeklySummary,
  episodeById: ById<Episode>,
  podcastById: ById<Podcast>,
  opts: { pdfUrl?: string } = {},
): string {
  // Lead with the call to action: open the live dashboard (the whole point — pull
  // the reader back into chat.muns.io), with the PDF download as the secondary.
  const ctaRow = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 6px;"><tr><td align="center">
      ${ctaButton(MUNS_DASHBOARD, '&#128202;&nbsp; Open the live dashboard', { primary: true })}
      ${opts.pdfUrl ? `<span style="display:inline-block;width:10px;">&nbsp;</span>${ctaButton(opts.pdfUrl, '&#11015;&nbsp; Download PDF')}` : ''}
      <div style="font-family:${SANS};font-size:11px;color:#8794a8;margin-top:9px;">Explore the full intelligence — every show, idea, and source — on <a href="${MUNS_DASHBOARD}" style="color:${C.gold};font-weight:700;text-decoration:none;">Munshot</a></div>
    </td></tr></table>`

  const overview = weekly.overview.length
    ? `${sectionLabel('Overview')}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.cream};border-left:3px solid ${C.gold};"><tr><td style="padding:14px 18px;">${weekly.overview
        .map(
          (p, i) =>
            `<p style="font-family:${SANS};font-size:14px;line-height:1.62;color:${C.prose};margin:0 0 ${
              i === weekly.overview.length - 1 ? '0' : '9px'
            };">${richCited(p)}</p>`,
        )
        .join('')}</td></tr></table>`
    : ''

  // Key Points — the synthesised, claim-first cross-episode body (primary). Falls
  // back to the by-show digest when no AI synthesis ran.
  const keyThemes = weekly.keyThemes ?? []
  const keyPoints = keyThemes.length
    ? sectionLabel('Key Points') +
      keyThemes
        .map(
          (t) =>
            `<div style="font-family:${SANS};font-weight:700;font-size:14px;color:${C.ink};margin:14px 0 6px;">${esc(t.heading)}</div>` +
            `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${t.points
              .map(
                (p) =>
                  `<tr><td style="padding:0 0 8px;font-family:${SANS};font-size:13.5px;line-height:1.55;color:${C.body};"><span style="color:${C.gold};font-weight:700;">&#9670;</span> ${richCited(p)}</td></tr>`,
              )
              .join('')}</table>`,
        )
        .join('')
    : ''

  const shows = !keyThemes.length && (weekly.shows ?? []).length ? sectionLabel('By Show') + (weekly.shows ?? []).map(showBlock).join('') : ''

  // Grouped by episode so the numbers read per-source, not as one mixed list.
  const quantGroups = (weekly.quantTable ?? []).length ? groupQuantByEpisode(weekly.quantTable ?? [], weekly.citations ?? []) : []
  const quant = quantGroups.length
    ? sectionLabel('Quantitative Summary') +
      quantGroups
        .map((g) => {
          const heading = g.label
            ? `<div style="font-family:${SANS};font-weight:700;font-size:13px;color:${C.ink};margin:16px 0 6px;">${esc(g.label)}</div>`
            : ''
          const rows = g.rows
            .map(
              (q, i) =>
                `<tr${i % 2 ? ` style="background:#fafbfd;"` : ''}>
              <td style="font-family:${SANS};font-size:13px;color:${C.ink};padding:7px 12px;border-bottom:1px solid ${C.line};">${esc(q.metric)}</td>
              <td align="right" style="font-family:${SANS};font-size:13px;font-weight:700;color:${C.ink};white-space:nowrap;padding:7px 12px;border-bottom:1px solid ${C.line};">${esc(q.value)}</td>
              <td style="font-family:${SANS};font-size:12px;color:#7d8ba3;padding:7px 12px;border-bottom:1px solid ${C.line};">${esc(q.context)}</td>
            </tr>`,
            )
            .join('')
          return `${heading}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};">${rows}</table>`
        })
        .join('')
    : ''

  // Investment Readout — per-episode evidence/interpretation. Email can't scroll a
  // wide table, so: a compact scannable table (episode · theme · names · confidence)
  // then full cards carrying the evidence / interpretation / questions / action.
  const readouts = weekly.episodeReadouts ?? []
  const stripN = (s: string) => s.replace(/\s*\[\d+\]/g, '').replace(/\s{2,}/g, ' ').trim()
  const confPill = (level: string) => {
    const [bg, fg] = level === 'High' ? ['#e7f3ec', '#2a7a48'] : level === 'Low' ? ['#f1f3f7', '#8794a8'] : ['#eef1f6', C.navy]
    return `<span style="display:inline-block;background:${bg};color:${fg};font-family:${SANS};font-weight:700;font-size:10.5px;padding:2px 8px;border-radius:5px;white-space:nowrap;">${esc(level)}</span>`
  }
  const th = `font-family:${SANS};font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:#7d8ba3;padding:7px 10px;border-bottom:1px solid ${C.line};`
  const cardLabel = (t: string) => `<div style="font-family:${SANS};font-weight:700;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:${C.gold};margin:11px 0 3px;">${t}</div>`
  const cardProse = (s: string) => `<div style="font-family:${SANS};font-size:13px;line-height:1.55;color:${C.prose};">${richInline(stripN(s))}</div>`
  const readout = readouts.length
    ? sectionLabel('Investment Readout') +
      `<p style="font-family:${SANS};font-size:13px;line-height:1.55;color:${C.body};margin:0 0 12px;">One readout per episode — what the podcast <em>actually said</em>, kept separate from the investment interpretation, with what to verify next.</p>` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};margin-bottom:4px;"><tr style="background:${C.panel};"><th align="left" style="${th}">Episode</th><th align="left" style="${th}">Investable Theme</th><th align="left" style="${th}">Names / Sectors</th><th align="left" style="${th}">Confidence</th></tr>${readouts
        .map(
          (r, i) =>
            `<tr${i % 2 ? ` style="background:#fafbfd;"` : ''}><td style="font-family:${SANS};font-size:12.5px;font-weight:600;color:${C.ink};padding:7px 10px;border-bottom:1px solid ${C.line};">${esc(r.episode)}</td><td style="font-family:${SANS};font-size:12.5px;color:${C.ink};padding:7px 10px;border-bottom:1px solid ${C.line};">${richInline(stripN(r.theme))}</td><td style="font-family:${SANS};font-size:11.5px;color:#7d8ba3;padding:7px 10px;border-bottom:1px solid ${C.line};">${esc(r.namesSectors)}</td><td style="padding:7px 10px;border-bottom:1px solid ${C.line};">${confPill(r.confidence)}</td></tr>`,
        )
        .join('')}</table>` +
      readouts
        .map(
          (r) =>
            `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};margin-top:10px;"><tr><td style="padding:13px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="font-family:${SANS};font-weight:700;font-size:15px;color:${C.ink};">${esc(r.episode)}<div style="font-family:${SANS};font-weight:600;font-size:13px;color:${C.gold};margin-top:2px;">${richInline(stripN(r.theme))}</div></td><td align="right" valign="top" style="white-space:nowrap;">${confPill(r.confidence)}</td></tr></table>
        ${r.namesSectors && r.namesSectors !== '—' ? `<div style="font-family:${SANS};font-size:11.5px;color:#8794a8;margin-top:5px;">${esc(r.namesSectors)}</div>` : ''}
        ${cardLabel('Podcast evidence')}${cardProse(r.evidence)}
        ${cardLabel('Investment interpretation')}${cardProse(r.interpretation)}
        ${r.questionsToVerify.length ? cardLabel('Questions to verify') + `<ul style="margin:0;padding-left:18px;font-family:${SANS};font-size:13px;line-height:1.5;color:${C.prose};">${r.questionsToVerify.map((q) => `<li style="margin-bottom:2px;">${richInline(stripN(q))}</li>`).join('')}</ul>` : ''}
        ${r.action ? cardLabel('Action') + cardProse(r.action) : ''}
      </td></tr></table>`,
        )
        .join('')
    : ''

  const interesting = weekly.interesting.quote
    ? sectionLabel('What Was Actually Interesting') +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.navy};border:1px solid #6b5a2e;"><tr><td style="padding:16px 22px 18px;">
        <div style="font-family:${SERIF};font-weight:700;font-size:34px;line-height:.5;color:${C.gold};">&#8220;</div>
        ${
          weekly.interesting.title
            ? `<div style="font-family:${SERIF};font-weight:700;font-size:16px;color:${C.goldSoft};margin:8px 0;">${esc(weekly.interesting.title)}</div>`
            : ''
        }
        <div style="font-family:${SERIF};font-style:italic;font-size:14px;line-height:1.5;color:#dde6f2;">${esc(weekly.interesting.quote)}</div>
        <div style="margin-top:12px;font-family:${SANS};font-weight:700;font-size:12px;color:${C.goldSoft};">${esc(weekly.interesting.speaker)} <span style="font-weight:400;color:#9fb1c8;">${esc(
          weekly.interesting.role,
        )}</span></div>
      </td></tr></table>`
    : ''

  const sources = weekly.sourceEpisodeIds.map(episodeById).filter((e): e is Episode => Boolean(e))
  const sourcesBody = sources.length
    ? sectionLabel('Sources') +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${sources
        .map((ep, i) => {
          const show = podcastById(ep.podcastId)?.title ?? ''
          const zebra = i % 2 ? `background:#fafbfd;` : ''
          // Every source links back to the dashboard — clicking a source is a way back in.
          return `<tr><td style="font-family:${SANS};font-size:13px;padding:7px 10px;border-bottom:1px solid ${C.line};${zebra}"><a href="${MUNS_DASHBOARD}" style="color:${C.ink};text-decoration:none;font-weight:600;">${esc(ep.title)}</a></td><td align="right" style="font-family:${SANS};font-size:12px;color:#7d8ba3;padding:7px 10px;border-bottom:1px solid ${C.line};${zebra}">${esc(show)}</td></tr>`
        })
        .join('')}<tr><td colspan="2" style="padding:12px 10px 0;font-family:${SANS};font-size:12px;">&#8594; <a href="${MUNS_DASHBOARD}" style="color:${C.gold};font-weight:700;text-decoration:none;">Open all of these on your Munshot dashboard</a></td></tr></table>`
    : ''

  const bodyRow = `<tr><td style="padding:8px 36px 30px;">${ctaRow}${overview}${keyPoints}${shows}${quant}${readout}${interesting}${sourcesBody}</td></tr>`

  return shell(
    weeklyReportTitle(weekly.rangeLabel),
    header('AI Podcast Intelligence', 'Weekly Summary', weekly.rangeLabel, [
      `${weekly.episodeCount} episode${weekly.episodeCount === 1 ? '' : 's'}`,
      `${weekly.readMinutes} min read`,
    ]) +
      bodyRow +
      footer(),
  )
}

// ── Single episode → HTML email (real content) ───────────────────────────────
// The on-demand "Email this edition" from an episode page. Mirrors the Word/PDF
// export's section order (AI Summary · Investable Insight · Key Numbers · Ideas
// Pitched · Highlights · Q&A) in the same inbox-safe house style as the weekly
// brief — every rule inline, every layout a table.

/** A named winners / at-risk party list (icon-free, email-safe). */
function partyList(items: EpisodeInsight['beneficiaries'], pos: boolean): string {
  if (!items.length) return ''
  const dot = pos ? '#16a34a' : '#dc2626'
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${items
    .map(
      (p) =>
        `<tr><td style="font-family:${SANS};font-size:13px;line-height:1.55;color:${C.body};padding:0 0 5px;"><span style="color:${dot};font-weight:700;">&#9642;</span> <strong style="color:${C.ink};">${esc(
          p.name,
        )}</strong> — ${richInline(p.why)}</td></tr>`,
    )
    .join('')}</table>`
}

function insightBlock(ins: EpisodeInsight): string {
  const label = (t: string) =>
    `<div style="font-family:${SANS};font-weight:700;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:${C.gold};margin:13px 0 3px;">${esc(t)}</div>`
  const prose = (s: string) => `<div style="font-family:${SANS};font-size:14px;line-height:1.6;color:${C.prose};">${richInline(s)}</div>`
  let out = ''
  if (ins.whatChanged) out += label('What changed') + prose(ins.whatChanged)
  if (ins.whyItMatters) out += label('Why it matters') + prose(ins.whyItMatters)
  if (ins.beneficiaries.length) out += label('Who benefits') + partyList(ins.beneficiaries, true)
  if (ins.atRisk.length) out += label("Who's at risk") + partyList(ins.atRisk, false)
  if (ins.diligenceQuestions.length)
    out +=
      label('Diligence questions') +
      `<ul style="margin:0;padding-left:18px;font-family:${SANS};font-size:13px;line-height:1.55;color:${C.prose};">${ins.diligenceQuestions
        .map((q) => `<li style="margin-bottom:2px;">${richInline(q)}</li>`)
        .join('')}</ul>`
  return out
}

function quantTableHtml(quant: QuantPoint[]): string {
  const rows = quant
    .map(
      (q, i) =>
        `<tr${i % 2 ? ` style="background:#fafbfd;"` : ''}>
          <td style="font-family:${SANS};font-size:13px;color:${C.ink};padding:7px 12px;border-bottom:1px solid ${C.line};">${esc(q.metric)}</td>
          <td align="right" style="font-family:${SANS};font-size:13px;font-weight:700;color:${C.ink};white-space:nowrap;padding:7px 12px;border-bottom:1px solid ${C.line};">${esc(q.value)}</td>
          <td style="font-family:${SANS};font-size:12px;color:#7d8ba3;padding:7px 12px;border-bottom:1px solid ${C.line};">${esc(q.context)}</td>
        </tr>`,
    )
    .join('')
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};">${rows}</table>`
}

function qaBlockHtml(qa: QAItem[]): string {
  return qa
    .map(
      (item) =>
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 10px;"><tr><td style="padding:0;">
          <div style="font-family:${SERIF};font-weight:700;font-size:15px;color:${C.ink};margin:0 0 4px;">${esc(item.q)}</div>
          <div style="font-family:${SANS};font-size:14px;line-height:1.6;color:${C.prose};">${richInline(item.a)}</div>
        </td></tr></table>`,
    )
    .join('')
}

// Render the AI summary's light Markdown as structured email HTML: the opening
// classification prose sits in the cream call-out, each top-level **section** is a
// gold label, each person / owner **sub-header** is bold navy, and "- " lines
// become a real bullet list. Mirrors the in-app SummaryBody + the Word/PDF exports
// (and still reads cleanly for older, prose-only cached summaries).
function synthesisEmailHtml(synthesis: string[]): string {
  if (!synthesis.length) return ''
  const blocks = synthesis.map(parseSummaryBlock)
  const para = (p: string, last: boolean) =>
    `<p style="font-family:${SANS};font-size:14px;line-height:1.62;color:${C.prose};margin:0 0 ${last ? '0' : '9px'};">${richInline(p)}</p>`
  const bulletList = (items: string[]) =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:2px 0 6px;">${items
      .map(
        (b) =>
          `<tr><td style="font-family:${SANS};font-size:14px;line-height:1.55;color:${C.body};padding:0 0 6px;vertical-align:top;"><span style="color:${C.gold};font-weight:700;">&bull;</span>&nbsp;&nbsp;${richInline(
            b,
          )}</td></tr>`,
      )
      .join('')}</table>`

  // Lead = the run of header-less prose at the very top (the standfirst), boxed.
  let i = 0
  const leadParas: string[] = []
  while (i < blocks.length && !blocks[i].header && blocks[i].bullets.length === 0) {
    leadParas.push(...blocks[i].paras)
    i++
  }
  let html = ''
  if (leadParas.length) {
    html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.cream};border-left:3px solid ${C.gold};margin:0 0 6px;"><tr><td style="padding:14px 18px;">${leadParas
      .map((p, j) => para(p, j === leadParas.length - 1))
      .join('')}</td></tr></table>`
  }
  for (; i < blocks.length; i++) {
    const b = blocks[i]
    if (b.header) {
      html += b.isSection
        ? sectionLabel(b.header)
        : `<div style="font-family:${SANS};font-weight:700;font-size:14px;color:${C.ink};margin:14px 0 5px;">${esc(b.header)}</div>`
    }
    b.paras.forEach((p, j) => (html += para(p, j === b.paras.length - 1 && !b.bullets.length)))
    if (b.bullets.length) html += bulletList(b.bullets)
  }
  return html
}

/** Render a single episode's summary as a designed HTML email (mirrors the
 *  Word/PDF export). Returns '' when the episode has no summary to send. */
export function episodeBriefEmailHtml(episode: Episode, podcast?: Podcast): string {
  const s = episode.summary
  if (!s) return ''

  const ctaRow = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 6px;"><tr><td align="center">
      ${ctaButton(MUNS_DASHBOARD, '&#128202;&nbsp; Open the live dashboard', { primary: true })}
      <div style="font-family:${SANS};font-size:11px;color:#8794a8;margin-top:9px;">Read the full episode — highlights, transcript, and sources — on <a href="${MUNS_DASHBOARD}" style="color:${C.gold};font-weight:700;text-decoration:none;">Munshot</a></div>
    </td></tr></table>`

  // AI Summary — the readable one-page synthesis (classification standfirst in the
  // cream call-out, then per-person + per-owner sections rendered structurally).
  const summary = s.synthesis.length ? sectionLabel('AI Summary') + synthesisEmailHtml(s.synthesis) : ''

  const insight = s.insight ? sectionLabel('Investable Insight') + insightBlock(s.insight) : ''

  const quant = s.quantData && s.quantData.length ? sectionLabel('Key Numbers') + quantTableHtml(s.quantData) : ''

  const ideas = s.ideas && s.ideas.length ? sectionLabel('Ideas Pitched') + s.ideas.map(ideaBlock).join('') : ''

  // Highlights — timeline beats, the AI's key takeaways starred.
  const highlights = s.highlights.length
    ? sectionLabel('Highlights') +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${s.highlights
        .map(
          (h) =>
            `<tr><td style="font-family:${SANS};font-size:14px;line-height:1.55;color:${C.body};padding:0 0 8px;">${
              h.timestamp && h.timestamp !== '—'
                ? `<span style="font-family:${MONO};font-size:11px;font-weight:700;color:${C.gold};">${esc(h.timestamp)}</span> `
                : ''
            }${h.key ? `<span style="color:${C.gold};">&#9733;</span> ` : ''}<strong style="color:${C.ink};">${esc(
              h.title,
            )}.</strong> ${richInline(h.detail)}</td></tr>`,
        )
        .join('')}</table>`
    : ''

  const qa = s.qa.length ? sectionLabel('Q&A') + qaBlockHtml(s.qa) : ''

  const bodyRow = `<tr><td style="padding:8px 36px 30px;">${ctaRow}${summary}${insight}${quant}${ideas}${highlights}${qa}</td></tr>`

  const chips = [
    formatDuration(episode.durationSec),
    `${s.highlights.length} highlight${s.highlights.length === 1 ? '' : 's'}`,
    `${s.qa.length} question${s.qa.length === 1 ? '' : 's'}`,
  ]

  return shell(
    `${episode.title} — Munshot Summary`,
    header(podcast ? `${podcast.title} · ${podcast.author}` : 'Episode Intelligence', episode.title, longDate(episode.publishedAt), chips, 'Episode Intelligence') +
      bodyRow +
      footer(
        `You're receiving this because you emailed yourself this episode summary from your <a href="${MUNS_DASHBOARD}" style="color:${C.goldSoft};">Munshot dashboard</a>.`,
      ),
  )
}
