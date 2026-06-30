// Word (.doc) export — Word-compatible HTML with real @page margins, so the
// download opens directly in Word / Pages / Google Docs with clean, well-spaced
// formatting. No HTML file, no print dialog, no iframe.
//
// House style ("institution grade") ported from the Munshot design kit, adapted to
// what Word's HTML engine actually supports: navy/gold/slate palette, a Georgia
// (serif) display role, Calibri body, Consolas for mono data. Word has NO gradients,
// NO @font-face, NO CSS variables, NO pseudo-elements, NO flex/grid — so every
// colour is a literal hex, every layout is a table/block, and bullets/rules/quote
// marks are real glyphs or bordered cells. (The full font-embedded design lives in
// the PDF pipeline; this is the best faithful rendering Word allows.)

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Escape first, then promote **bold** markup to <strong> (mirrors the in-app
// renderer). <strong> is painted gold inside prose/cards via CSS — the design's
// "emphasis = gold" rule.
export function inline(s: string): string {
  return esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
}

export function sanitizeFilename(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 120)
}

// ── Cover ────────────────────────────────────────────────────────────────────
// A navy hero block (full content width, gold frame + rules) that opens the
// document, then forces the interior onto a fresh page. `logo` is an optional
// base64 data-URI of the gold "M"; without it a typographic mark is used.
export interface CoverOptions {
  title: string
  eyebrow?: string
  kicker?: string // top-right brand label, e.g. "Weekly Intelligence"
  dateRange?: string
  chips?: string[]
  logo?: string
  footerLeft?: string // raw HTML allowed
}

export function cover(o: CoverOptions): string {
  const hero = o.logo
    ? `<img class="cv-logo" src="${o.logo}" width="80" height="80" alt="" />`
    : `<div class="cv-mark">M</div>`
  const brand = o.logo ? `<img class="cv-bimg" src="${o.logo}" width="24" height="24" alt="" /> ` : ''
  const chipsHtml = (o.chips ?? [])
    .filter(Boolean)
    .map((c) => `<span class="cv-chip">${esc(c)}</span>`)
    .join('<span class="cv-cdot">&middot;</span>')
  return `<table class="cover" role="presentation" cellpadding="0" cellspacing="0"><tr><td class="cover-cell">
      <table class="cv-top" role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td class="cv-brand">${brand}<span class="cv-bn">Munshot</span></td>
        <td class="cv-kick">${esc(o.kicker ?? '')}</td>
      </tr></table>
      <div class="cv-rule"></div>
      <div class="cv-hero">
        <div class="cv-logowrap">${hero}</div>
        ${o.eyebrow ? `<div class="cv-eyebrow">${esc(o.eyebrow)}</div>` : ''}
        <div class="cv-title">${esc(o.title)}</div>
        ${o.dateRange ? `<div class="cv-date">${esc(o.dateRange)}</div>` : ''}
        ${chipsHtml ? `<div class="cv-chips">${chipsHtml}</div>` : ''}
      </div>
      <div class="cv-rule"></div>
      <table class="cv-bot" role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td class="cv-bl">${o.footerLeft ?? ''}</td>
        <td class="cv-br">${esc(o.dateRange ?? '')}</td>
      </tr></table>
    </td></tr></table>`
}

// ── Section header ───────────────────────────────────────────────────────────
// Gold serif index + navy serif title + a gold hairline rule that fills the row.
export function section(num: string, title: string, body: string): string {
  if (!body) return ''
  return `<div class="sec">
      <table class="sec-head" role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td class="sec-num">${esc(num)}</td>
        <td class="sec-title">${esc(title)}</td>
        <td class="sec-rule"></td>
      </tr></table>${body}</div>`
}

// Mono/gold chips (Top Themes etc.).
export function chips(items: string[]): string {
  if (!items.length) return ''
  return `<p class="chips">${items.map((i) => `<span class="chip">${esc(i)}</span>`).join(' ')}</p>`
}

// A small uppercase count/label pill (gold-tint).
export function pill(text: string): string {
  return `<span class="pill">${esc(text)}</span>`
}

// A colour-coded show tag (sources table).
export function tag(text: string, color: 'navy' | 'gold' | 'slate'): string {
  return `<span class="tag tag-${color}">${esc(text)}</span>`
}

// Lead paragraph with a raised gold initial (Word-safe stand-in for a drop cap);
// the remainder still renders **bold** as gold emphasis.
export function leadParagraph(text: string): string {
  const t = (text ?? '').replace(/^\s+/, '')
  if (!t) return ''
  return `<span class="dropcap">${esc(t.charAt(0))}</span>${inline(t.slice(1))}`
}

const DOC_CSS = `
  @page WordSection1 { size: A4; margin: 1.7cm 1.8cm 1.9cm 1.8cm; }
  div.WordSection1 { page: WordSection1; }

  body { font-family: Calibri, "Segoe UI", Helvetica, Arial, sans-serif; font-size: 10.5pt; line-height: 1.55; color: #42506a; }
  p { margin: 0 0 9pt; }
  strong, b { font-weight: 700; color: #1a2b4a; }
  a { color: #1a2b4a; text-decoration: none; }

  /* ===== Cover ===== */
  table.cover { width: 100%; border-collapse: collapse; page-break-after: always; margin-bottom: 4pt; }
  .cover-cell { background: #14233c; color: #e8eef7; border: 1px solid #b8902f; padding: 24pt 30pt 20pt; }
  table.cv-top { width: 100%; }
  .cv-brand { font-family: Georgia, "Times New Roman", serif; font-weight: 700; font-size: 14pt; color: #f3f6fb; letter-spacing: 1px; }
  .cv-bimg { vertical-align: middle; }
  .cv-bn { vertical-align: middle; }
  .cv-kick { text-align: right; font-family: Calibri, sans-serif; font-weight: 700; font-size: 8pt; letter-spacing: 3px; text-transform: uppercase; color: #e7cf93; }
  .cv-rule { border-top: 1px solid #9c7b2e; height: 0; line-height: 0; font-size: 0; margin: 11pt 0; }
  .cv-hero { text-align: center; padding: 30pt 0 26pt; }
  .cv-logo { margin-bottom: 13pt; }
  .cv-mark { font-family: Georgia, serif; font-weight: 700; font-size: 50pt; line-height: 1; color: #cea344; }
  .cv-eyebrow { font-family: Calibri, sans-serif; font-weight: 700; font-size: 9pt; letter-spacing: 5px; text-transform: uppercase; color: #cea344; margin-bottom: 9pt; }
  .cv-title { font-family: Georgia, "Times New Roman", serif; font-weight: 700; font-size: 40pt; line-height: 1.02; color: #f4eedf; }
  .cv-date { font-family: Georgia, serif; font-style: italic; font-size: 16pt; color: #e7cf93; margin-top: 12pt; }
  .cv-chips { margin-top: 15pt; }
  .cv-chip { font-family: Consolas, "Courier New", monospace; font-size: 8pt; letter-spacing: 2px; text-transform: uppercase; color: #cdd7e6; border: 1px solid #9c7b2e; padding: 3pt 10pt; }
  .cv-cdot { color: #5c6a80; padding: 0 7pt; }
  table.cv-bot { width: 100%; }
  .cv-bl { font-family: Calibri, sans-serif; font-size: 8pt; color: #9fb0c6; }
  .cv-bl b { color: #e7eef7; font-weight: 700; }
  .cv-br { text-align: right; font-family: Consolas, "Courier New", monospace; font-size: 8pt; letter-spacing: 1.5px; text-transform: uppercase; color: #e7cf93; }

  /* ===== Section header ===== */
  .sec { margin-top: 19pt; }
  table.sec-head { width: 100%; margin-bottom: 9pt; page-break-after: avoid; }
  .sec-num { font-family: Georgia, "Times New Roman", serif; font-weight: 700; font-size: 21pt; color: #b8902f; white-space: nowrap; width: 1%; padding-right: 11px; vertical-align: bottom; }
  .sec-title { font-family: Georgia, "Times New Roman", serif; font-weight: 700; font-size: 15pt; color: #1a2b4a; white-space: nowrap; width: 1%; vertical-align: bottom; }
  .sec-rule { border-bottom: 1px solid #d8b86a; vertical-align: bottom; padding-bottom: 5pt; }

  /* ===== Lead / prose ===== */
  .lead { background: #faf6ea; border-left: 3px solid #b8902f; padding: 13pt 16pt; }
  .lead p { font-size: 10.5pt; line-height: 1.62; color: #2b3850; margin: 0 0 8pt; }
  .lead p.last { margin-bottom: 0; }
  .dropcap { font-family: Georgia, "Times New Roman", serif; font-weight: 700; font-size: 23pt; color: #b8902f; }
  .lead strong, .idea strong, .tlist strong, .qa-a strong, .prose strong { color: #b8902f; font-weight: 700; }
  .prose p { font-size: 10.5pt; line-height: 1.6; color: #2b3850; margin: 0 0 9pt; }

  /* ===== By show ===== */
  .show-block { margin: 0 0 13pt; }
  .show-head { border-bottom: 1px solid #d4dbe6; padding-bottom: 5pt; margin: 0 0 8pt; page-break-after: avoid; }
  .show-name { font-family: Georgia, "Times New Roman", serif; font-weight: 700; font-size: 13.5pt; color: #1a2b4a; }
  .subhead { font-family: Calibri, sans-serif; font-weight: 700; font-size: 8pt; letter-spacing: 2px; text-transform: uppercase; color: #b8902f; border-left: 3px solid #b8902f; padding-left: 8px; margin: 11pt 0 6pt; page-break-after: avoid; }

  .idea { background: #f6f8fb; border: 1px solid #e6eaf1; border-left: 3px solid #b8902f; padding: 9pt 12pt; margin-bottom: 7pt; page-break-inside: avoid; }
  .idea-title { font-family: Georgia, "Times New Roman", serif; font-weight: 700; font-size: 11.5pt; color: #1a2b4a; margin: 0 0 4pt; }
  .idea-kind { font-family: Calibri, sans-serif; font-weight: 700; font-size: 7.5pt; letter-spacing: .5px; text-transform: uppercase; color: #b8902f; background: #faf6ea; border: 1px solid #e2cf95; padding: 1pt 6pt; margin-right: 6pt; }
  .idea-who { font-size: 8.5pt; color: #54606e; margin: 0 0 6pt; }
  .idea-who b { color: #1a2b4a; font-weight: 700; }
  ul.thesis { list-style: none; margin: 4pt 0 0; padding: 0; }
  ul.thesis li { font-size: 9.5pt; line-height: 1.5; color: #41506a; margin: 0 0 3pt; padding-left: 15px; text-indent: -15px; }
  ul.thesis li .di { color: #b8902f; font-size: 8pt; padding-right: 7px; }

  ul.tlist { list-style: none; margin: 0; padding: 0; }
  ul.tlist li { font-size: 10pt; line-height: 1.55; color: #42506a; margin: 0 0 6pt; padding-left: 16px; text-indent: -16px; }
  ul.tlist li .sq { color: #b8902f; padding-right: 8px; }
  .tlist .ti { font-family: Calibri, sans-serif; font-weight: 700; color: #1a2b4a; }

  .qs { background: #f6f8fb; border: 1px solid #e6eaf1; padding: 10pt 13pt; page-break-inside: avoid; }
  table.qgrid { width: 100%; }
  table.qgrid td { width: 50%; vertical-align: top; padding-right: 14pt; }
  .q { font-size: 9pt; line-height: 1.45; color: #46566f; font-style: italic; border-left: 2px solid #cea344; padding-left: 9px; margin: 0 0 7pt; }
  .q.last { margin-bottom: 0; }

  /* ===== Mentions ===== */
  table.cols { width: 100%; border: 1px solid #e6eaf1; border-collapse: collapse; }
  table.cols td { width: 50%; vertical-align: top; padding: 11pt 14pt; }
  table.cols td.right { border-left: 1px solid #e6eaf1; }
  .mh { font-family: Calibri, sans-serif; font-weight: 700; font-size: 8pt; letter-spacing: 2px; text-transform: uppercase; color: #1a2b4a; border-bottom: 1.5px solid #b8902f; padding-bottom: 5pt; margin-bottom: 8pt; }
  .mchip { font-family: Calibri, sans-serif; font-weight: 700; font-size: 8.5pt; color: #1a2b4a; background: #eef2f7; border: 1px solid #d4dbe6; padding: 3pt 9pt; white-space: nowrap; }
  .mempty { font-size: 11pt; color: #828c99; }

  /* ===== Quote (interesting) ===== */
  .interesting { background: #14233c; color: #dde6f2; border: 1px solid #6b5a2e; padding: 15pt 20pt 17pt; page-break-inside: avoid; }
  .int-mark { font-family: Georgia, serif; font-weight: 700; font-size: 38pt; line-height: .4; color: #b8902f; }
  .int-qt { font-family: Georgia, "Times New Roman", serif; font-weight: 700; font-size: 14pt; color: #e7cf93; margin: 7pt 0 8pt; }
  .int-ql { font-family: Georgia, serif; font-style: italic; font-size: 12pt; line-height: 1.5; color: #dde6f2; }
  .int-at { margin-top: 12pt; }
  .int-at .who { font-family: Calibri, sans-serif; font-weight: 700; font-size: 8.5pt; color: #cea344; }
  .int-at .role { font-family: Calibri, sans-serif; font-size: 8pt; color: #9fb1c8; }

  /* ===== Highlights (episode) ===== */
  .moment { background: #f6f8fb; border: 1px solid #e6eaf1; border-left: 3px solid #b8902f; padding: 10pt 13pt; margin-bottom: 7pt; page-break-inside: avoid; }
  .m-title { font-family: Georgia, "Times New Roman", serif; font-weight: 700; font-size: 11.5pt; color: #1a2b4a; margin: 0 0 3pt; }
  .ts { font-family: Consolas, "Courier New", monospace; font-size: 8pt; color: #b8902f; background: #faf6ea; border: 1px solid #e2cf95; padding: 1pt 6pt; margin-right: 7px; }
  .m-star { color: #b8902f; }
  .m-why { font-size: 10pt; color: #42506a; margin: 0; }

  /* ===== Q&A (episode) ===== */
  .qa-item { padding: 11pt 0; border-bottom: 1px solid #e6eaf1; page-break-inside: avoid; }
  .qa-q { font-family: Georgia, "Times New Roman", serif; font-weight: 700; font-size: 11.5pt; color: #1a2b4a; margin: 0 0 5pt; }
  .qb { font-family: Calibri, sans-serif; font-weight: 700; font-size: 8pt; color: #ffffff; background: #b8902f; padding: 1pt 7pt; margin-right: 7px; }
  .qa-a { font-size: 10pt; color: #42506a; margin: 0; }

  /* ===== Chips / pills / tags ===== */
  .chips { margin: 0; line-height: 2.2; }
  .chip { font-family: Consolas, "Courier New", monospace; font-size: 8.5pt; letter-spacing: 1px; text-transform: uppercase; color: #1a2b4a; background: #faf6ea; border: 1px solid #e2cf95; padding: 3pt 9pt; white-space: nowrap; }
  .pill { font-family: Calibri, sans-serif; font-weight: 700; font-size: 8pt; letter-spacing: .5px; text-transform: uppercase; color: #b8902f; background: #faf6ea; border: 1px solid #e2cf95; padding: 2pt 9pt; }
  .tag { font-family: Calibri, sans-serif; font-weight: 700; font-size: 7.5pt; letter-spacing: .5px; text-transform: uppercase; padding: 2pt 9pt; white-space: nowrap; }
  .tag-navy { background: #1a2b4a; color: #eef3fa; }
  .tag-gold { background: #b8902f; color: #ffffff; }
  .tag-slate { background: #54606e; color: #ffffff; }

  .callout { border: 1px solid #e6eaf1; border-left: 3px solid #94a3b8; padding: 10pt 13pt; margin-bottom: 7pt; font-size: 10pt; color: #42506a; }

  /* ===== Investable insight ===== */
  .ins-label { font-family: Calibri, sans-serif; font-weight: 700; font-size: 8pt; letter-spacing: 2px; text-transform: uppercase; color: #b8902f; margin: 11pt 0 4pt; page-break-after: avoid; }
  .ins-body { font-size: 10pt; line-height: 1.6; color: #2b3850; margin: 0 0 4pt; }
  .ins-body strong { color: #b8902f; font-weight: 700; }
  ul.parties { list-style: none; margin: 3pt 0 0; padding: 0; }
  ul.parties li { font-size: 9.5pt; line-height: 1.5; color: #41506a; margin: 0 0 3pt; padding-left: 15px; text-indent: -15px; }
  ul.parties li .di { font-size: 8pt; padding-right: 7px; }
  ul.parties.pos li .di { color: #15803d; }
  ul.parties.neg li .di { color: #b91c1c; }
  ul.parties li b { color: #1a2b4a; font-weight: 700; }

  /* ===== Data table (quant / comparison) ===== */
  table.dt { width: 100%; border-collapse: collapse; page-break-inside: avoid; }
  table.dt th { font-family: Calibri, sans-serif; font-weight: 700; font-size: 7pt; letter-spacing: 2px; text-transform: uppercase; color: #b8902f; text-align: left; padding: 0 9px 6pt; border-bottom: 1.5px solid #b8902f; }
  table.dt th.r { text-align: right; }
  table.dt td { font-family: Calibri, sans-serif; font-size: 9.5pt; color: #1a2b4a; padding: 6pt 9px; border-bottom: 1px solid #e6eaf1; vertical-align: top; line-height: 1.4; }
  table.dt td.num { text-align: right; font-weight: 700; white-space: nowrap; }
  table.dt td.ctx { color: #54606e; }
  table.dt tr.zebra td { background: #fafbfd; }
  .kpt-heading { font-family: Calibri, sans-serif; font-weight: 700; font-size: 11pt; color: #1a2b4a; margin: 12pt 0 5pt; page-break-after: avoid; }

  /* ===== Sources ===== */
  table.srcs { width: 100%; border-collapse: collapse; page-break-inside: avoid; }
  table.srcs th { font-family: Calibri, sans-serif; font-weight: 700; font-size: 7pt; letter-spacing: 2px; text-transform: uppercase; color: #b8902f; text-align: left; padding: 0 9px 6pt; border-bottom: 1.5px solid #b8902f; }
  table.srcs th.r { text-align: right; }
  table.srcs td { font-family: Calibri, sans-serif; font-size: 9.5pt; color: #1a2b4a; padding: 6pt 9px; border-bottom: 1px solid #e6eaf1; vertical-align: middle; line-height: 1.3; }
  table.srcs td.r { text-align: right; }
  table.srcs tr.zebra td { background: #fafbfd; }

  /* ===== Footer ===== */
  table.foot { width: 100%; margin-top: 22pt; border-top: 1px solid #d8c187; }
  table.foot td { padding-top: 10pt; font-family: Calibri, sans-serif; font-size: 8pt; color: #8893a2; }
  table.foot b { color: #b8902f; }
  table.foot .foot-r { text-align: right; letter-spacing: 1px; text-transform: uppercase; color: #b8902f; }
`

// Two-cell footer used by every document.
export function docFooter(left: string, right: string): string {
  return `<table class="foot" role="presentation" cellpadding="0" cellspacing="0"><tr>
      <td>${left}</td>
      <td class="foot-r">${esc(right)}</td>
    </tr></table>`
}

// Wrap a document body in the Word-compatible HTML shell.
export function wordShell(title: string, inner: string): string {
  return `<!doctype html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8" />
<meta name="ProgId" content="Word.Document" />
<title>${esc(title)}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom><w:DoNotOptimizeForBrowser/></w:WordDocument></xml><![endif]-->
<style>${DOC_CSS}</style>
</head>
<body><div class="WordSection1">${inner}</div></body>
</html>`
}

// Download a Word document directly. A leading BOM helps Word detect UTF-8.
export function downloadWord(filename: string, html: string): void {
  const name = filename.endsWith('.doc') ? filename : `${filename}.doc`
  const blob = new Blob(['﻿', html], { type: 'application/msword' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
