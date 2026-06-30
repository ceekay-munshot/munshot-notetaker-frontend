import { scopedKey } from './storageScope'

// ─────────────────────────────────────────────────────────────────────────────
// Extra recipients for the on-demand "Email this edition" send — the addresses
// the user adds *besides* themselves. Stored per browser/origin, scoped per
// Munshot user via scopedKey (anonymous keeps the legacy key), mirroring
// trackedStore / processedStore. The user's own address is never stored here;
// it's added at send time (see normalizeRecipients), so this list is purely the
// "and also send to…" people.
// ─────────────────────────────────────────────────────────────────────────────

const BASE = 'munshot:weekly-recipients:v1'
const MAX = 20 // a sane cap (also keeps on-demand sends well under the relay's rate limits)

// Matches the server proxy's validation (no commas/semicolons/angle brackets, so
// one address can never smuggle a second recipient or a header-injection newline).
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email)
}

/** Saved extra recipients, in the order they were added. Never throws. */
export function loadRecipients(): string[] {
  try {
    const raw = localStorage.getItem(scopedKey(BASE))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string' && isValidEmail(x)) : []
  } catch {
    return []
  }
}

/**
 * Pure add-to-list: validates, de-dupes (case-insensitive), and caps. Returns the
 * outcome plus the resulting list, so callers (and tests) don't touch storage.
 */
export function computeAdd(list: string[], email: string): { ok: boolean; message?: string; list: string[] } {
  const e = email.trim()
  if (!isValidEmail(e)) return { ok: false, message: 'Enter a valid email address.', list }
  if (list.some((x) => x.toLowerCase() === e.toLowerCase())) return { ok: false, message: 'That address is already on the list.', list }
  if (list.length >= MAX) return { ok: false, message: `You can add up to ${MAX} recipients.`, list }
  return { ok: true, list: [...list, e] }
}

/** Add an extra recipient (idempotent, validated). Returns the outcome + new list. */
export function addRecipient(email: string): { ok: boolean; message?: string; list: string[] } {
  const res = computeAdd(loadRecipients(), email)
  if (res.ok) persist(res.list)
  return res
}

/** Forget an extra recipient (case-insensitive). Returns the new list. */
export function removeRecipient(email: string): string[] {
  const next = loadRecipients().filter((x) => x.toLowerCase() !== email.trim().toLowerCase())
  persist(next)
  return next
}

/**
 * Final, de-duplicated recipient set for a send: the user first, then the saved
 * extras, dropping blanks, invalids, and case-insensitive duplicates (so the user
 * is never emailed twice even if they also added their own address).
 */
export function normalizeRecipients(self: string | null | undefined, extras: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of [self ?? '', ...extras]) {
    const e = (raw ?? '').trim()
    if (!isValidEmail(e)) continue
    const k = e.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(e)
  }
  return out
}

function persist(list: string[]): void {
  try {
    localStorage.setItem(scopedKey(BASE), JSON.stringify(list.slice(0, MAX)))
  } catch {
    /* storage unavailable (private mode) or over quota — adds still work in-session */
  }
}
