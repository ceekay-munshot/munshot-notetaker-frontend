import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import * as api from '../lib/api'
import { useHostContext } from '../hooks/useHostContext'
import { decodeHostToken, isExpired } from '../lib/hostToken'

// Session gate for the whole app. Two independent sources feed it:
//  - the Munshot host JWT (session.token, from useHostContext) when embedded —
//    the host owns identity, so a valid token skips the login page entirely
//    and we adopt the email decoded from it.
//  - the Worker's own /api/me cookie session, used only when there's no host
//    token (standalone / outside the Munshot iframe).
// Sign-in / sign-up / sign-out (email+password) only ever run on the standalone
// path — a host-managed session has no logout of its own; the host owns it.

export type AuthState =
  | { status: 'loading' }
  | { status: 'anon'; codeRequired: boolean }
  | {
      status: 'authed'
      email: string
      isAdmin: boolean
      hostManaged: boolean
      /** Organisation id from the host token. Carried for visibility only —
       *  nothing in the app or the Worker scopes anything by it. */
      orgId: string | null
      /** Why the host JWT could not be exchanged for a Worker session cookie,
       *  or null when there was nothing to exchange / it succeeded. NON-NULL
       *  MEANS THE UI IS SIGNED IN BUT THE API IS NOT: every /api/* call will
       *  401, so the dashboard would otherwise render empty with no explanation.
       *  Surfaced by <SessionNotice>. */
      hostSessionError: string | null
    }

interface AuthApi {
  state: AuthState
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string, code?: string) => Promise<void>
  signOut: () => Promise<void>
  /** Re-attempt a failed host-token exchange (the failed token is otherwise
   *  remembered and not retried, so nothing would recover on its own). */
  retryHostSession: () => void
}

const Ctx = createContext<AuthApi | null>(null)

function isEmbeddedWindow(): boolean {
  try {
    return window.self !== window.top
  } catch {
    return true // blocked from reading window.top → cross-origin iframe
  }
}

// How long to wait for the host's postMessage handshake (host:init) before
// falling back to the standalone /api/me probe, when embedded but no token
// has arrived yet on the very first resolution. The SDK's message listener
// attaches at module load, so the token is normally already cached before
// this component's first effect runs — this is just insurance against a slow
// handshake, so we don't flash the login page while embedded.
const HOST_HANDSHAKE_GRACE_MS = 2000

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' })
  const { session } = useHostContext()
  const resolvedOnceRef = useRef(false)
  const loggedTokenRef = useRef(false)
  const exchangedTokenRef = useRef<string | null>(null)
  const hostManagedRef = useRef(false)
  const hostSessionErrorRef = useRef<string | null>(null)
  const [retryTick, setRetryTick] = useState(0)

  const refresh = useCallback(async () => {
    try {
      const me = await api.getMe()
      if (me.authenticated) {
        setState({
          status: 'authed',
          email: me.email || '',
          isAdmin: !!me.isAdmin,
          hostManaged: false,
          orgId: me.orgId ?? null,
          hostSessionError: null,
        })
      } else {
        setState({ status: 'anon', codeRequired: !!me.codeRequired })
      }
    } catch {
      setState({ status: 'anon', codeRequired: false })
    } finally {
      resolvedOnceRef.current = true
    }
  }, [])

  const retryHostSession = useCallback(() => {
    exchangedTokenRef.current = null
    setRetryTick((n) => n + 1)
  }, [])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    async function run() {
      const claims = decodeHostToken(session.token)

      if (session.token && claims && !isExpired(claims)) {
        if (!loggedTokenRef.current) {
          loggedTokenRef.current = true
          console.info('[dashboard] host session token received')
        }

        // Exchange the host JWT for a real Worker session cookie, so /api/*
        // calls succeed from inside the host iframe (see api.hostLogin / the
        // Worker's handleHostLogin — the token's signature isn't verified
        // there either; see the caveat on that route). Only once per distinct
        // token.
        //
        // A failed exchange still lets the UI proceed — but it is NOT harmless
        // and must not be swallowed: without the cookie every /api/* call 401s,
        // so the dashboard renders signed-in and completely empty (no meetings,
        // no search, no summaries) with nothing on screen to say why. Keep the
        // reason so <SessionNotice> can state it, and so retryHostSession() has
        // something to clear.
        // Held in a ref, not read off `state`: this effect must not depend on
        // the state it sets, or every resolution would re-trigger it.
        if (exchangedTokenRef.current !== session.token) {
          exchangedTokenRef.current = session.token
          try {
            await api.hostLogin(session.token)
            hostSessionErrorRef.current = null
          } catch (err) {
            hostSessionErrorRef.current =
              err instanceof api.ApiError ? err.message : 'The Munshot host session could not be established.'
            console.error('[dashboard] host session exchange failed', err)
          }
        }
        if (cancelled) return

        hostManagedRef.current = true
        resolvedOnceRef.current = true
        setState({
          status: 'authed',
          email: claims.email ?? session.email ?? '',
          isAdmin: false,
          hostManaged: true,
          orgId: claims.orgId ?? session.orgId ?? null,
          hostSessionError: hostSessionErrorRef.current,
        })
        return
      }

      loggedTokenRef.current = false
      exchangedTokenRef.current = null
      hostSessionErrorRef.current = null

      // The host token disappeared after we'd established a host session
      // (a host-side logout) — clear the Worker's own cookie too, so a
      // soft-navigated iframe never keeps a stale session around.
      if (hostManagedRef.current) {
        hostManagedRef.current = false
        try {
          await api.logout()
        } catch {
          /* best-effort */
        }
        if (cancelled) return
      }

      // No valid host token. On the very first resolution attempt while
      // embedded, give the handshake a brief grace period — an early render
      // can beat host:init even though the SDK's listener is already live.
      // Once we've resolved once (authed or anon), any later loss of the
      // token falls back to the standalone probe immediately, so the login
      // page appears without delay.
      if (!resolvedOnceRef.current && isEmbeddedWindow()) {
        timer = setTimeout(() => void refresh(), HOST_HANDSHAKE_GRACE_MS)
        return
      }
      void refresh()
    }

    void run()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [session.token, session.email, session.orgId, refresh, retryTick])

  const signIn = useCallback(
    async (email: string, password: string) => {
      await api.login(email, password)
      await refresh()
    },
    [refresh],
  )

  const signUp = useCallback(
    async (email: string, password: string, code?: string) => {
      await api.register(email, password, code)
      await refresh()
    },
    [refresh],
  )

  const signOut = useCallback(async () => {
    try {
      await api.logout()
    } finally {
      setState({ status: 'anon', codeRequired: false })
      await refresh()
    }
  }, [refresh])

  return (
    <Ctx.Provider value={{ state, signIn, signUp, signOut, retryHostSession }}>{children}</Ctx.Provider>
  )
}

export function useAuth(): AuthApi {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>')
  return ctx
}
