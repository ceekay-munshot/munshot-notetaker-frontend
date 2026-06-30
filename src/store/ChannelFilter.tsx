import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

// Global channel (podcast / source) filter shared by the top-bar selector, the
// Home dashboard, and the Episodes list. `channelId === null` means "All Channels".

interface ChannelFilterValue {
  channelId: string | null
  setChannel: (id: string | null) => void
  /** True if a podcast id matches the active channel (always true when "All Channels"). */
  inChannel: (podcastId: string) => boolean
}

const Ctx = createContext<ChannelFilterValue | null>(null)

export function ChannelFilterProvider({ children }: { children: ReactNode }) {
  const [channelId, setChannelId] = useState<string | null>(null)

  const setChannel = useCallback((id: string | null) => setChannelId(id), [])

  const inChannel = useCallback(
    (podcastId: string) => channelId === null || podcastId === channelId,
    [channelId],
  )

  const value = useMemo<ChannelFilterValue>(
    () => ({ channelId, setChannel, inChannel }),
    [channelId, setChannel, inChannel],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useChannelFilter(): ChannelFilterValue {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useChannelFilter must be used within <ChannelFilterProvider>')
  return ctx
}
