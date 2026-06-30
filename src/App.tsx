import { Route, Routes, Link } from 'react-router-dom'
import { AppDataProvider } from './store/AppData'
import { DateRangeProvider } from './store/DateRange'
import { ChannelFilterProvider } from './store/ChannelFilter'
import { SentimentProvider } from './store/Sentiment'
import { Layout } from './components/Layout'
import { Icon } from './components/Icon'
import Home from './pages/Home'
import Discover from './pages/Discover'
import Episodes from './pages/Episodes'
import EpisodeDetail from './pages/EpisodeDetail'
import Weekly from './pages/Weekly'
import WeeklyArchive from './pages/WeeklyArchive'
import Search from './pages/Search'

export default function App() {
  return (
    <AppDataProvider>
      <DateRangeProvider>
        <ChannelFilterProvider>
          <SentimentProvider>
            <Routes>
              <Route element={<Layout />}>
                <Route index element={<Home />} />
                <Route path="discover" element={<Discover />} />
                <Route path="episodes" element={<Episodes />} />
                <Route path="episodes/:id" element={<EpisodeDetail />} />
                <Route path="weekly" element={<Weekly />} />
                <Route path="weekly/archive" element={<WeeklyArchive />} />
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
