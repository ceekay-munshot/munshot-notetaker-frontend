import { useEffect, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { useAppData } from '../store/AppData'
import { useDashboardCapture } from '../hooks/useDashboardCapture'
import { MobileSidebar, Sidebar } from './Sidebar'
import { TopBar } from './TopBar'
import { Icon } from './Icon'

export function Layout() {
  const { loading, podcasts, episodes, weekly, identity } = useAppData()
  const location = useLocation()
  const [menuOpen, setMenuOpen] = useState(false)

  // Navigating anywhere dismisses the drawer (covers back/forward too).
  useEffect(() => {
    setMenuOpen(false)
  }, [location.pathname, location.search])

  // Answer the host's dashboard.capture.snapshot request with a small, bounded,
  // structured-cloneable view of the current state (≤512 KB per the standard).
  useDashboardCapture(() => ({
    context: { route: location.pathname, identity: identity?.email ?? null },
    selection: {},
    data: {
      trackedPodcasts: podcasts.filter((p) => p.tracked).length,
      totalPodcasts: podcasts.length,
      episodes: episodes.length,
      hasWeekly: !!weekly,
      loading,
    },
  }))

  return (
    <div className="min-h-screen bg-background">
      <Sidebar />
      <MobileSidebar open={menuOpen} onClose={() => setMenuOpen(false)} />
      <div className="flex min-h-screen flex-col md:ml-64">
        <TopBar menuOpen={menuOpen} onMenu={() => setMenuOpen(true)} />
        <main id="dashboard-main" data-dashboard-capture-root="true" className="flex-1 px-lg pb-lg pt-lg">
          <div className="mx-auto max-w-container">{loading ? <LoadingState /> : <Outlet />}</div>
        </main>
      </div>
    </div>
  )
}

function LoadingState() {
  return (
    <div className="grid place-items-center py-[20vh] text-secondary">
      <Icon name="graphic_eq" size={36} className="mb-sm motion-safe:animate-pulse text-primary" />
      <p className="text-metadata">Loading your intelligence feed…</p>
    </div>
  )
}
