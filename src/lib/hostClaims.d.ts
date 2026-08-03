// Types for hostClaims.js. The implementation is plain JS on purpose (see the
// header there); this file is what lets TypeScript callers import it under
// `allowJs: false`.

export declare const EMAIL_CLAIMS: readonly string[]
export declare const ORG_ID_CLAIMS: readonly string[]

export declare function looksLikeEmail(value: unknown): boolean
export declare function readEmailClaim(payload: unknown): string | null
export declare function readOrgIdClaim(payload: unknown): string | null
export declare function claimNames(payload: unknown): string[]
export declare function decodeJwtPayload(
  token: string | null | undefined,
): Record<string, unknown> | null
