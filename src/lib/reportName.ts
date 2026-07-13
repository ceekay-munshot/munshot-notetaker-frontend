// ─────────────────────────────────────────────────────────────────────────────
// Download identity for the weekly-brief PDF — ONE source of truth for the brand
// name + date stamp, shared by the client download, the cron + on-demand hosting
// paths, and the GET endpoint that serves the bytes. Keeping it here (a tiny, dep-
// free module) lets the browser, the Pages Functions, and the Vite dev middleware
// all produce the SAME "Munshot AI Podcasts — <week>.pdf" filename.
// ─────────────────────────────────────────────────────────────────────────────

/** Brand stem for the weekly report — the date stamp is appended per edition. */
export const WEEKLY_REPORT_TITLE = 'Munshot AI Podcasts'

/** Query param that carries the desired download filename to the GET endpoint. */
export const REPORT_DL_PARAM = 'dl'

// Characters that aren't valid in a filename on common OSes. The spaces, dashes and
// commas in a range label ("Jun 22 – 28, 2026") are intentionally KEPT — they're
// legal in filenames and read well; only the truly-illegal set is stripped.
const ILLEGAL_FS = /[\\/:*?"<>|]+/g

/**
 * Human title for a week's report: "Munshot AI Podcasts — <range>". The ONE brand
 * string shared by the email subject, the email preheader, and the PDF/Word document
 * titles — so the file, the inbox line, and the document all read the same.
 */
export function weeklyReportTitle(rangeLabel: string): string {
  const range = (rangeLabel ?? '').replace(/\s+/g, ' ').trim()
  return range ? `${WEEKLY_REPORT_TITLE} — ${range}` : WEEKLY_REPORT_TITLE
}

/** Base name (no extension) for a week's report file: the title, made filesystem-safe. */
export function weeklyReportBaseName(rangeLabel: string): string {
  return weeklyReportTitle(rangeLabel).replace(ILLEGAL_FS, '').replace(/\s+/g, ' ').trim().slice(0, 150)
}

/** Full download filename for a week's report, e.g. "Munshot AI Podcasts — Jun 22 – 28, 2026.pdf". */
export function weeklyReportFilename(rangeLabel: string): string {
  return `${weeklyReportBaseName(rangeLabel)}.pdf`
}

/** Append the desired download filename to a hosted-report URL as `?dl=`/`&dl=`. */
export function withReportDownloadName(url: string, filename: string): string {
  if (!filename) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}${REPORT_DL_PARAM}=${encodeURIComponent(filename)}`
}

/** RFC 5987 token for a UTF-8 `filename*` value (handles the en-dash, etc.). */
function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

/**
 * Build a `Content-Disposition: inline` value that names the download. Emits BOTH a
 * plain ASCII `filename` (Unicode dashes transliterated to '-') for old clients AND a
 * UTF-8 `filename*` for modern ones, so the saved file keeps its proper name everywhere.
 */
export function contentDispositionInline(filename: string | null | undefined): string {
  const safe = (filename || `${WEEKLY_REPORT_TITLE}.pdf`).slice(0, 180)
  const ascii = safe
    .replace(/[‐-―]/g, '-') // hyphen/figure/en/em dashes → ASCII '-'
    .replace(/[^\x20-\x7E]/g, '-') // any remaining non-ASCII → '-'
    .replace(/["\\]/g, '') // can't appear inside the quoted form
    .replace(/\s+/g, ' ')
    .trim()
  return `inline; filename="${ascii}"; filename*=UTF-8''${rfc5987(safe)}`
}
