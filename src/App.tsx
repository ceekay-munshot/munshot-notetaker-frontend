import { Route, Routes, Link } from 'react-router-dom'
import { AuthProvider, useAuth } from './store/Auth'
import { AppDataProvider } from './store/AppData'
import { DateRangeProvider } from './store/DateRange'
import { ChannelFilterProvider } from './store/ChannelFilter'
import { SentimentProvider } from './store/Sentiment'
import { Layout } from './components/Layout'
import { Icon } from './components/Icon'
import Login from './pages/Login'
import Home from './pages/Home'
import Discover from './pages/Discover'
import Episodes from './pages/Episodes'
import EpisodeDetail from './pages/EpisodeDetail'
import Weekly from './pages/Weekly'
import WeeklyArchive from './pages/WeeklyArchive'
import Search from './pages/Search'
import Tracking from './pages/Tracking'
import ScheduledMeetings from './pages/ScheduledMeetings'

export default function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  )
}

// Auth gate: a splash while the session is probed, the login screen when there's
// no session, and the full dashboard once signed in.
function Gate() {
  const { state } = useAuth()
  if (state.status === 'loading') return <Splash />
  if (state.status === 'anon') return <Login codeRequired={state.codeRequired} />
  return <Dashboard />
}

function Splash() {
  return (
    <div className="grid min-h-screen place-items-center bg-background">
      <div className="flex items-center gap-3 text-secondary">
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-outline-variant border-t-primary" />
        <span className="text-body-md">Signing you in…</span>
      </div>
    </div>
  )
}

function Dashboard() {
  return (
    <AppDataProvider>
      <DateRangeProvider>
        <ChannelFilterProvider>
          <SentimentProvider>
            <Routes>
              <Route element={<Layout />}>
                <Route index element={<Home />} />
                <Route path="discover" element={<Discover />} />
                <Route path="meetings" element={<Episodes />} />
                <Route path="meetings/:id" element={<EpisodeDetail />} />
                {/* Back-compat with the old podcast routes. */}
                <Route path="episodes" element={<Episodes />} />
                <Route path="episodes/:id" element={<EpisodeDetail />} />
                <Route path="weekly" element={<Weekly />} />
                <Route path="weekly/archive" element={<WeeklyArchive />} />
                <Route path="tracking" element={<Tracking />} />
                <Route path="scheduled" element={<ScheduledMeetings />} />
                <Route path="search" element={<Search />} />
                <Route path="*" element={<NotFound />} />
              </Route>
            </Routes>
          </SentimentProvider>
        </ChannelFilterProvider>
      </DateRangeProvider>
    </AppDataProvider>
  )
}

function NotFound() {
  return (
    <div className="grid place-items-center py-[20vh] text-center">
      <Icon name="explore_off" size={40} className="mb-sm text-outline" />
      <h2 className="text-display-sm text-on-surface">Page not found</h2>
      <Link to="/" className="mt-sm text-metadata font-semibold text-primary hover:underline">
        Back to Today's Intelligence
      </Link>
    </div>
  )
}
