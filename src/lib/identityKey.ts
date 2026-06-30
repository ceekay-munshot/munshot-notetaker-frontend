import { stableHash } from './hash'

// ─────────────────────────────────────────────────────────────────────────────
// THE one user-identity canonicalizer — shared by the browser and the server.
//
// The Munshot host injects a user identity (userId/email) into the embedded
// dashboard; that identity scopes three things that must NEVER diverge:
//   • the `x-munshot-user` request header the client sends,
//   • the localStorage key suffix the client reads/writes,
//   • the KV key segment (and dev-cache filename) the server stores under.
// Both sides funnel through this module (server/identity.ts re-exports it), so
// `Alice@Example.com` cannot map to one bucket in the browser and another in KV.
//
// Dependency-light on purpose: imports only the pure stableHash, so it's safe
// in the Workers bundle, the Vite middleware, and the browser alike.
// ─────────────────────────────────────────────────────────────────────────────

/** Request header carrying the canonical user key on same-origin /api/* calls.
 *  Lowercase on purpose: Node's req.headers are lowercased and Headers.get is
 *  case-insensitive, so one constant serves the browser and both server runtimes. */
export const USER_HEADER = 'x-munshot-user'

/** Longest canonical key we emit — keeps KV keys/filenames tidy. */
export const MAX_UID = 64

// Anything the raw identity contains beyond this is ignored before processing —
// a hostile mega-header can't make us hash megabytes.
const MAX_RAW = 512

/**
 * Deterministic, idempotent: raw identity → a safe KV/localStorage/header key
 * segment, or null (no usable identity → anonymous/legacy behavior).
 *
 * Already-canonical ids (lowercase, `[a-z0-9@._-]`, ≤ 64 chars — e.g. most
 * emails) pass through unchanged so stored keys stay human-debuggable. Anything
 * lossy — case folding, charset replacement, truncation — appends a hash of the
 * PRE-sanitization value, so distinct raw ids (`usr_AbC` vs `usr_abc`, two
 * unicode names that sanitize alike) can never collide. The hash gets reserved
 * room, so it is never truncated away. Re-canonicalizing any output returns it
 * unchanged, which lets the server safely re-run this on client-sent keys.
 *
 * The charset is header-safe and filename-safe (no `/`, `\`, `%`, control
 * chars), so no URI-encoding is needed anywhere in the pipeline. No
 * crypto.subtle: it's async-only in Workers, and hashing adds no security here —
 * the header is trusted, this is purely about key hygiene and collisions.
 */
export function canonicalUserKey(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim().slice(0, MAX_RAW)
  if (!trimmed) return null
  const sanitized = trimmed.toLowerCase().replace(/[^a-z0-9@._-]/g, '_')
  let key = sanitized
  if (sanitized !== trimmed || sanitized.length > MAX_UID) {
    const h = stableHash(trimmed) // hash the pre-sanitization value: lossy inputs stay distinct
    key = `${sanitized.slice(0, MAX_UID - h.length - 1)}-${h}` // reserve room — suffix never truncated
  }
  // All-punctuation results (`..`, `___`, `--`) carry no identity and could only
  // produce confusing keys/filenames — treat as anonymous.
  return /^[@._-]*$/.test(key) ? null : key
}
