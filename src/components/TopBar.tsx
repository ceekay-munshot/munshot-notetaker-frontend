import { useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppData } from '../store/AppData'
import { useDateRange } from '../store/DateRange'
import { useChannelFilter } from '../store/ChannelFilter'
import { useSentiment } from '../store/Sentiment'
import { CoverTile } from './CoverTile'
import { Icon } from './Icon'

export function TopBar({ menuOpen, onMenu }: { menuOpen: boolean; onMenu: () => void }) {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const { podcasts, episodes } = useAppData()
  const { preset, presets, setPreset, rangeLabel } = useDateRange()
  const { channelId, setChannel } = useChannelFilter()
  const { on: sentimentOn, toggle: toggleSentiment } = useSentiment()
  const [dateOpen, setDateOpen] = useState(false)
  const [chanOpen, setChanOpen] = useState(false)

  // Channels that actually have episodes, alphabetised — every option yields results.
  const channels = podcasts
    .filter((p) => episodes.some((e) => e.podcastId === p.id))
    .sort((a, b) => a.title.localeCompare(b.title))
  const selected = channelId ? podcasts.find((p) => p.id === channelId) : undefined

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    navigate(q.trim() ? `/search?q=${encodeURIComponent(q.trim())}` : '/search')
  }

  return (
    <header className="sticky top-0 z-40 h-16 border-b border-outline-variant bg-surface/85 backdrop-blur-md">
      <div className="flex h-full items-center gap-sm px-md md:gap-md md:px-lg">
        {/* Mobile nav trigger — the drawer slides in from this side */}
        <button
          onClick={onMenu}
          aria-label="Open navigation"
          aria-expanded={menuOpen}
          aria-controls="mobile-nav"
          className="press -ml-1 grid h-10 w-10 shrink-0 place-items-center rounded-lg text-on-surface hover:bg-surface-container-low md:hidden"
        >
          <Icon name="menu" size={22} />
        </button>

        {/* Search */}
        <form onSubmit={onSubmit} className="group relative w-full max-w-xl">
          <Icon
            name="search"
            size={20}
            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-outline transition-colors group-focus-within:text-primary"
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search episodes, podcasts, people, companies…"
            className="w-full rounded-xl border border-outline-variant bg-surface-container-low py-2.5 pl-11 pr-sm text-[14px] text-on-surface outline-none transition-colors placeholder:text-outline focus:border-primary focus:bg-surface focus:ring-2 focus:ring-primary/15"
          />
        </form>

        <div className="ml-auto flex items-center gap-2.5">
          {/* Sentiment coloring toggle — the two dots are the legend (green = positive, red = negative) */}
          <button
            onClick={toggleSentiment}
            aria-pressed={sentimentOn}
            title={
              sentimentOn
                ? 'Sentiment coloring on — green = positive, red = negative. Click to turn off.'
                : 'Sentiment coloring off. Click to color positive (green) and negative (red) language.'
            }
            className={`hidden items-center gap-2 rounded-xl border px-3 py-2 text-[13px] font-medium transition-[background-color,border-color,color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.97] sm:flex ${
              sentimentOn
                ? 'border-primary bg-surface-container-low text-on-surface'
                : 'border-outline-variant bg-surface text-secondary hover:bg-surface-container-low'
            }`}
          >
            <span className="flex items-center gap-1" aria-hidden>
              <span className={`h-2.5 w-2.5 rounded-full bg-success transition-opacity ${sentimentOn ? '' : 'opacity-30'}`} />
              <span className={`h-2.5 w-2.5 rounded-full bg-error transition-opacity ${sentimentOn ? '' : 'opacity-30'}`} />
            </span>
            Sentiment
          </button>

          {/* Channel filter — wired to the global ChannelFilter store */}
          <div className="relative hidden md:block">
            <button
              onClick={() => setChanOpen((o) => !o)}
              className={`press flex items-center gap-2 whitespace-nowrap rounded-xl border px-3 py-2 text-[13px] font-medium ${
                chanOpen || selected
                  ? 'border-primary bg-surface-container-low text-on-surface'
                  : 'border-outline-variant bg-surface text-on-surface hover:bg-surface-container-low'
              }`}
            >
              {selected ? (
                <CoverTile podcast={selected} className="h-4 w-4" rounded="rounded" />
              ) : (
                <span className="grid h-4 w-4 place-items-center rounded bg-inverse-surface text-[8px] font-bold text-white">M</span>
              )}
              <span className="max-w-[150px] truncate">{selected ? selected.title : 'All Channels'}</span>
              <Icon name="expand_more" size={18} className={`text-outline transition-transform ${chanOpen ? 'rotate-180' : ''}`} />
            </button>

            {chanOpen && (
              <>
                <button className="fixed inset-0 z-40 cursor-default" aria-hidden onClick={() => setChanOpen(false)} />
                <div className="pop absolute right-0 z-50 mt-2 max-h-[70vh] w-64 origin-top-right overflow-y-auto rounded-xl border border-outline-variant bg-surface p-1 shadow-card-hover">
                  <p className="px-2.5 py-1.5 text-label-caps uppercase text-outline">Filter by channel</p>
                  <button
                    onClick={() => {
                      setChannel(null)
                      setChanOpen(false)
                    }}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[14px] transition-colors ${
                      channelId === null ? 'bg-primary-fixed/50 font-semibold text-primary' : 'text-on-surface hover:bg-surface-container-low'
                    }`}
                  >
                    <span className="grid h-5 w-5 shrink-0 place-items-center rounded bg-inverse-surface text-[9px] font-bold text-white">M</span>
                    <span className="flex-1 text-left">All Channels</span>
                    {channelId === null && <Icon name="check" size={16} className="shrink-0" />}
                  </button>
                  {channels.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => {
                        setChannel(p.id)
                        setChanOpen(false)
                      }}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[14px] transition-colors ${
                        channelId === p.id ? 'bg-primary-fixed/50 font-semibold text-primary' : 'text-on-surface hover:bg-surface-container-low'
                      }`}
                    >
                      <CoverTile podcast={p} className="h-5 w-5 shrink-0" rounded="rounded" />
                      <span className="flex-1 truncate text-left">{p.title}</span>
                      {channelId === p.id && <Icon name="check" size={16} className="shrink-0" />}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Date range — wired to the global DateRange store */}
          <div className="relative hidden lg:block">
            <button
              onClick={() => setDateOpen((o) => !o)}
              className={`press flex items-center gap-2 whitespace-nowrap rounded-xl border px-3 py-2 text-[13px] font-medium ${
                dateOpen ? 'border-primary bg-surface-container-low text-on-surface' : 'border-outline-variant bg-surface text-on-surface hover:bg-surface-container-low'
              }`}
            >
              <Icon name="calendar_today" size={16} className="text-outline" />
              {rangeLabel}
              <Icon name="expand_more" size={18} className={`text-outline transition-transform ${dateOpen ? 'rotate-180' : ''}`} />
            </button>

            {dateOpen && (
              <>
                <button className="fixed inset-0 z-40 cursor-default" aria-hidden onClick={() => setDateOpen(false)} />
                <div className="pop absolute right-0 z-50 mt-2 w-52 origin-top-right rounded-xl border border-outline-variant bg-surface p-1 shadow-card-hover">
                  <p className="px-2.5 py-1.5 text-label-caps uppercase text-outline">Filter by date</p>
                  {presets.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => {
                        setPreset(p.id)
                        setDateOpen(false)
                      }}
                      className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-[14px] transition-colors ${
                        preset.id === p.id ? 'bg-primary-fixed/50 font-semibold text-primary' : 'text-on-surface hover:bg-surface-container-low'
                      }`}
                    >
                      {p.label}
                      {preset.id === p.id && <Icon name="check" size={16} />}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

        </div>
      </div>
    </header>
  )
}
