// ─────────────────────────────────────────────────────────────────────────────
// Visual shell — no backend. This module used to attach the Munshot identity
// header to same-origin /api/* requests; the data layer (src/lib/api.ts) now
// resolves entirely from in-memory mock data, so nothing here makes a network
// call. `setApiUser` is kept as an inert no-op purely so AppData's existing
// import keeps resolving.
// ─────────────────────────────────────────────────────────────────────────────

/** No-op in the shell: there is no per-user backend to scope. */
export function setApiUser(_key: string | null): void {}
