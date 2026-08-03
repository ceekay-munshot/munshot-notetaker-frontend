// ─────────────────────────────────────────────────────────────────────────────
// THE one host-JWT claim reader — shared by the browser and the Worker.
//
// The Munshot host hands the embedded dashboard a JWT over postMessage
// (session.token). Two independent places have to agree on what is inside it:
//   • src/lib/hostToken.ts, which decides who the UI thinks is signed in, and
//   • worker/index.js's handleHostLogin, which mints the session cookie that
//     every /api/* call is authorized against.
//
// When those two disagree the app fails in its worst possible way: the UI
// renders as signed-in while the cookie exchange 400s, so every data call 401s
// and the dashboard comes up authenticated-but-EMPTY — no meetings, no search,
// no error message. That is indistinguishable from "you have no meetings yet",
// which is what makes it so hard to diagnose from a support report. Both sides
// funnel through this module so the two readings cannot drift apart. (Same
// reasoning, and the same shape, as src/lib/identityKey.ts.)
//
// Plain JS with no imports on purpose: it has to load unchanged in the Workers
// bundle, under Vite, and under bare `node` (scripts/chat-pipeline.test.mjs and
// scripts/chat-eval.mjs import worker/index.js directly, and node cannot load
// TypeScript). Types for TS callers live in hostClaims.d.ts next door.
// ─────────────────────────────────────────────────────────────────────────────

/** Claim names that may carry the user's email address, best first. `sub` is
 *  also consulted (last) but only when it parses as an email — plenty of issuers
 *  put an opaque id there, and adopting that as an identity would silently key
 *  the session to something no meeting is ever filed under. */
export const EMAIL_CLAIMS = [
  'email',
  'user_email',
  'userEmail',
  'email_address',
  'emailAddress',
  'preferred_username',
  'upn',
  'unique_name',
]

/** Claim names that may carry the organisation id, best first. Accepted as a
 *  number too — a numeric org id is common, and a `typeof === 'string'` test
 *  reads it as absent. */
export const ORG_ID_CLAIMS = [
  'orgId',
  'org_id',
  'organisationId',
  'organisation_id',
  'organizationId',
  'organization_id',
  'tenantId',
  'tenant_id',
  'companyId',
  'company_id',
]

/** Same shape the Worker validates registrations against, so a claim this
 *  accepts is never rejected one layer down. */
export function looksLikeEmail(value) {
  return typeof value === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim())
}

/** First of `keys` present on `payload` as a non-empty string or finite number. */
function scalarClaim(payload, keys) {
  if (!payload || typeof payload !== 'object') return null
  for (const key of keys) {
    const raw = payload[key]
    if (typeof raw === 'string' && raw.trim()) return raw.trim()
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  }
  return null
}

/** The user's email, or null when no claim carries one that parses as an
 *  address. Returned trimmed but NOT case-folded — callers normalize (the
 *  Worker through normalizeEmail) so stored keys stay canonical while the UI can
 *  still show the address the way the host spelled it. */
export function readEmailClaim(payload) {
  for (const key of EMAIL_CLAIMS) {
    const value = scalarClaim(payload, [key])
    if (looksLikeEmail(value)) return value
  }
  const sub = scalarClaim(payload, ['sub'])
  return looksLikeEmail(sub) ? sub : null
}

/** The organisation id, or null. Nothing authorizes on this today — it is
 *  carried so the value is actually observable (via /api/me and
 *  /api/debug/whoami) instead of being decoded and dropped, which is what made
 *  "is this an org mismatch?" unanswerable without reading the source. */
export function readOrgIdClaim(payload) {
  return scalarClaim(payload, ORG_ID_CLAIMS)
}

/** Claim NAMES present on a payload, sorted. Names only, never values — this
 *  goes into error responses so a token whose email lives under an unexpected
 *  key is diagnosable without leaking its contents into logs. */
export function claimNames(payload) {
  if (!payload || typeof payload !== 'object') return []
  return Object.keys(payload).sort()
}

/**
 * Decodes a JWT's payload segment. DECODE ONLY — the signature is never
 * verified, here or anywhere else in this repo: that needs the host's signing
 * secret, which must not be bundled into the frontend and is not configured on
 * the Worker either. See the security caveat on worker/index.js's
 * handleHostLogin. Returns null on any malformed input; never throws.
 */
export function decodeJwtPayload(token) {
  if (!token) return null
  const parts = String(token).split('.')
  if (parts.length !== 3) return null
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const binary = atob(padded)
    // Decode as UTF-8 rather than reading atob's output directly, so a non-ASCII
    // display name or address survives the round trip intact.
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
    const payload = JSON.parse(new TextDecoder('utf-8').decode(bytes))
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null
  } catch {
    return null
  }
}
