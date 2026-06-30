// ─────────────────────────────────────────────────────────────────────────────
// Visual shell — no Munshot host, no identity. The real module resolved a
// signed-in user from host postMessage context and re-scoped the app per user.
// This standalone UI build is always anonymous: there is no host to read from,
// so identity is permanently null and never transitions.
//
// The public surface (Identity, getIdentity, onIdentityChange, resolveIdentity,
// isEmbedded) is preserved so AppData and Sidebar keep importing it unchanged —
// they just always see the anonymous (shared) state.
// ─────────────────────────────────────────────────────────────────────────────

export interface Identity {
  /** The raw host-provided id (the session email). For display/debug. */
  userId: string
  /** What scopes storage, headers, and KV. Never null here. */
  key: string
  email?: string
  name?: string
}

/** Always null in the shell — there is no signed-in user. */
export function getIdentity(): Identity | null {
  return null
}

/** No identity transitions ever occur in the shell. Returns an unsubscribe no-op. */
export function onIdentityChange(_cb: (identity: Identity | null) => void): () => void {
  return () => {}
}

/** Resolves immediately to null (anonymous / shared space). */
export function resolveIdentity(): Promise<Identity | null> {
  return Promise.resolve(null)
}

/** This standalone UI build never runs inside the Munshot host iframe. */
export function isEmbedded(): boolean {
  return false
}
