// src/lib/hostToken.ts
//
// Decodes the JWT the Munshot host hands us over postMessage (session.token,
// see src/lib/sdk.ts / src/hooks/useHostContext.ts). This is a DECODE ONLY
// parser — it never verifies the signature, since that would require the
// signing secret, which must never be bundled into this frontend. The token
// is trusted because it arrives from the parent host window, not because we
// verify it ourselves.
//
// The claim reading itself lives in src/lib/hostClaims.js, shared verbatim with
// the Worker's handleHostLogin — see the header there for why the two must not
// have their own copies.

import { claimNames, decodeJwtPayload, readEmailClaim, readOrgIdClaim } from './hostClaims.js'

export interface HostTokenClaims {
  email: string | null
  sub: string | null
  orgId: string | null
  authority: string | null
  exp: number | null // seconds since epoch
  /** Claim names the token actually carried, sorted. Names only, never values.
   *  Surfaced in the session diagnostics so a token whose email sits under an
   *  unexpected key is visible instead of just reading as "no email". */
  claimNames: string[]
}

/** Decodes the payload of a JWT. Returns null on any malformed input — never throws. */
export function decodeHostToken(token: string | null | undefined): HostTokenClaims | null {
  const payload = decodeJwtPayload(token)
  if (!payload) return null

  return {
    email: readEmailClaim(payload),
    sub: typeof payload.sub === 'string' ? payload.sub : null,
    orgId: readOrgIdClaim(payload),
    authority: typeof payload.authority === 'string' ? payload.authority : null,
    exp: typeof payload.exp === 'number' ? payload.exp : null,
    claimNames: claimNames(payload),
  }
}

/** True if the claims carry an `exp` that has already passed. No `exp` is never expired. */
export function isExpired(claims: HostTokenClaims): boolean {
  if (claims.exp == null) return false
  return Date.now() >= claims.exp * 1000
}
