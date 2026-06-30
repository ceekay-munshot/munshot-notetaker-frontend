import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

// Global on/off for sentiment coloring (green = positive, red = negative). Shared
// by the top-bar toggle, RichText (Summary / Takeaways / Q&A / Moments / Home /
// Weekly), and the transcript. Default ON, persisted so the choice sticks.

const STORAGE_KEY = 'munshot:sentiment'

interface SentimentValue {
  on: boolean
  toggle: () => void
  setOn: (v: boolean) => void
}

const Ctx = createContext<SentimentValue | null>(null)

function initialOn(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== '0' // default on; only an explicit "0" disables
  } catch {
    return true
  }
}

export function SentimentProvider({ children }: { children: ReactNode }) {
  const [on, setOnState] = useState<boolean>(initialOn)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, on ? '1' : '0')
    } catch {
      /* private mode / storage disabled — preference just won't persist */
    }
  }, [on])

  const setOn = useCallback((v: boolean) => setOnState(v), [])
  const toggle = useCallback(() => setOnState((p) => !p), [])

  const value = useMemo<SentimentValue>(() => ({ on, toggle, setOn }), [on, toggle, setOn])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useSentiment(): SentimentValue {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useSentiment must be used within <SentimentProvider>')
  return ctx
}
