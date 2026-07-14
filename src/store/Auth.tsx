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
  | { status: 'authed'; email: string; isAdmin: boolean; hostManaged: boolean }

interface AuthApi {
  state: AuthState
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string, code?: string) => Promise<void>
  signOut: () => Promise<void>
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

  const refresh = useCallback(async () => {
    try {
      const me = await api.getMe()
      if (me.authenticated) {
        setState({ status: 'authed', email: me.email || '', isAdmin: !!me.isAdmin, hostManaged: false })
      } else {
        setState({ status: 'anon', codeRequired: !!me.codeRequired })
      }
    } catch {
      setState({ status: 'anon', codeRequired: false })
    } finally {
      resolvedOnceRef.current = true
    }
  }, [])

  useEffect(() => {
    const claims = decodeHostToken(session.token)

    if (session.token && claims && !isExpired(claims)) {
      if (!loggedTokenRef.current) {
        loggedTokenRef.current = true
        console.info('[dashboard] host session token received')
      }
      resolvedOnceRef.current = true
      setState({
        status: 'authed',
        email: claims.email ?? session.email ?? '',
        isAdmin: false,
        hostManaged: true,
      })
      return
    }

    loggedTokenRef.current = false

    // No valid host token. On the very first resolution attempt while
    // embedded, give the handshake a brief grace period — an early render can
    // beat host:init even though the SDK's listener is already live. Once
    // we've resolved once (authed or anon), any later loss of the token (a
    // host logout) falls back to the standalone probe immediately, so the
    // login page appears without delay.
    if (!resolvedOnceRef.current && isEmbeddedWindow()) {
      const timer = setTimeout(() => void refresh(), HOST_HANDSHAKE_GRACE_MS)
      return () => clearTimeout(timer)
    }
    void refresh()
  }, [session.token, session.email, refresh])

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

  return <Ctx.Provider value={{ state, signIn, signUp, signOut }}>{children}</Ctx.Provider>
}

export function useAuth(): AuthApi {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>')
  return ctx
}
