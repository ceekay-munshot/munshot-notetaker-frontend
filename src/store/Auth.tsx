import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import * as api from '../lib/api'

// Session gate for the whole app. Boots by probing /api/me; until that resolves
// the app shows a splash, then either the login screen (unauthenticated) or the
// dashboard (authenticated). Sign-in / sign-up / sign-out all run through the
// Worker's auth routes and refresh this state.

export type AuthState =
  | { status: 'loading' }
  | { status: 'anon'; codeRequired: boolean }
  | { status: 'authed'; email: string; isAdmin: boolean }

interface AuthApi {
  state: AuthState
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string, code?: string) => Promise<void>
  signOut: () => Promise<void>
}

const Ctx = createContext<AuthApi | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' })

  const refresh = useCallback(async () => {
    try {
      const me = await api.getMe()
      if (me.authenticated) {
        setState({ status: 'authed', email: me.email || '', isAdmin: !!me.isAdmin })
      } else {
        setState({ status: 'anon', codeRequired: !!me.codeRequired })
      }
    } catch {
      setState({ status: 'anon', codeRequired: false })
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

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
