// src/lib/hostToken.ts
//
// Decodes the JWT the Munshot host hands us over postMessage (session.token,
// see src/lib/sdk.ts / src/hooks/useHostContext.ts). This is a DECODE ONLY
// parser — it never verifies the signature, since that would require the
// signing secret, which must never be bundled into this frontend. The token
// is trusted because it arrives from the parent host window, not because we
// verify it ourselves.

export interface HostTokenClaims {
  email: string | null
  sub: string | null
  orgId: string | null
  authority: string | null
  exp: number | null // seconds since epoch
}

function base64UrlDecode(segment: string): string {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder('utf-8').decode(bytes)
}

/** Decodes the payload of a JWT. Returns null on any malformed input — never throws. */
export function decodeHostToken(token: string | null | undefined): HostTokenClaims | null {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null

  try {
    const payload = JSON.parse(base64UrlDecode(parts[1]))
    return {
      email: typeof payload.email === 'string' ? payload.email : null,
      sub: typeof payload.sub === 'string' ? payload.sub : null,
      orgId: typeof payload.orgId === 'string' ? payload.orgId : null,
      authority: typeof payload.authority === 'string' ? payload.authority : null,
      exp: typeof payload.exp === 'number' ? payload.exp : null,
    }
  } catch {
    return null
  }
}

/** True if the claims carry an `exp` that has already passed. No `exp` is never expired. */
export function isExpired(claims: HostTokenClaims): boolean {
  if (claims.exp == null) return false
  return Date.now() >= claims.exp * 1000
}
