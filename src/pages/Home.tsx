import { Link } from 'react-router-dom'
import { useAppData } from '../store/AppData'
import { useDateRange } from '../store/DateRange'
import { useChannelFilter } from '../store/ChannelFilter'
import { formatDuration, longDate, relativeDate } from '../lib/format'
import { CoverTile } from '../components/CoverTile'
import { Icon } from '../components/Icon'
import { RichText, entityTerms } from '../components/RichText'
import { StatusBadge } from '../components/StatusBadge'
import { SendBotCard, SchedulesCard, CalendarCard } from '../components/NotetakerControls'
import { topTopics } from '../lib/topics'

export default function Home() {
  const { episodes, podcastById, isAdmin } = useAppData()
  const { preset, inRange, rangeLabel } = useDateRange()
  const { channelId, inChannel } = useChannelFilter()

  const channel = channelId ? podcastById(channelId) : undefined

  // Scope the whole dashboard to the selected meeting (all meetings when null).
  const scoped = episodes.filter((e) => inChannel(e.podcastId))
  const featured = scoped[0]
  const featuredPodcast = featured ? podcastById(featured.podcastId) : undefined

  const inWindow = scoped
    .filter((e) => inRange(e.publishedAt))
    .sort((a, b) => +new Date(b.publishedAt) - +new Date(a.publishedAt))
  const activity = inWindow.slice(0, 4)
  const recent = inWindow.filter((e) => e.id !== featured?.id).slice(0, 4)

  const ready = inWindow.filter((e) => e.status === 'ready')
  const stats = {
    meetings: inWindow.length,
    summaries: ready.filter((e) => e.summary).length,
    participants: new Set(inWindow.flatMap((e) => e.entities.people)).size,
  }
  const topics = topTopics(inWindow)

  return (
    <div className="animate-fade-up">
      <header className="mb-lg">
        <h2 className="text-display-lg text-on-background">Today's Intelligence</h2>
        <p className="mt-1 text-body-md text-secondary">
          {channel ? `Latest from ${channel.title}.` : 'AI summaries from your recorded meetings.'}
        </p>
      </header>

      {/* Notetaker actions — send the bot, schedule it, sync the calendar. */}
      {!isAdmin && (
        <div className="mb-gutter grid grid-cols-1 gap-gutter lg:grid-cols-3">
          <SendBotCard />
          <SchedulesCard />
          <CalendarCard />
        </div>
      )}

      <div className="grid grid-cols-1 gap-gutter lg:grid-cols-12">
        {/* Left column */}
        <div className="flex flex-col gap-gutter lg:col-span-8">
          {featured ? (
            <>
              {/* Featured meeting */}
              <article className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-md shadow-card">
                <div className="flex flex-col gap-md sm:flex-row">
                  {featuredPodcast && (
                    <CoverTile podcast={featuredPodcast} className="h-40 w-40 shrink-0" rounded="rounded-xl" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="rounded-full chip-signal px-2 py-0.5 text-label-caps uppercase">Latest</span>
                    </div>
                    <h3 className="mb-2 text-[22px] font-bold leading-tight tracking-tight text-on-background">
                      {featured.title}
                    </h3>
                    <div className="mb-2.5 flex flex-wrap items-center gap-3 text-metadata text-secondary">
                      <span className="inline-flex items-center gap-1">
                        <Icon name="calendar_today" size={14} /> {longDate(featured.publishedAt)}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Icon name="schedule" size={14} /> {formatDuration(featured.durationSec)}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Icon name="group" size={14} /> {featured.entities.people.length} participant
                        {featured.entities.people.length === 1 ? '' : 's'}
                      </span>
                    </div>
                    <p className="text-body-md leading-relaxed text-on-surface-variant">
                      <RichText text={featured.blurb} terms={entityTerms(featured.entities)} />
                    </p>
                  </div>
                </div>

                {featured.summary && featured.summary.synthesis.length > 0 && (
                  <div className="mt-md border-t border-outline-variant pt-md">
                    <h4 className="mb-2.5 text-[15px] font-semibold text-on-surface">Summary</h4>
                    <p className="line-clamp-4 text-body-md leading-relaxed text-on-surface-variant">
                      <RichText text={featured.summary.synthesis[0]} terms={entityTerms(featured.entities)} />
                    </p>
                  </div>
                )}

                <div className="mt-md flex flex-wrap items-center gap-2.5">
                  <Link
                    to={`/meetings/${featured.id}`}
                    className="press inline-flex items-center gap-2 rounded-lg bg-primary px-md py-2.5 text-metadata font-semibold text-on-primary hover:bg-primary-container"
                  >
                    <Icon name="description" size={18} /> Read Summary
                  </Link>
                  <Link
                    to={`/meetings/${featured.id}?tab=transcript`}
                    className="press inline-flex items-center gap-2 rounded-lg border border-outline-variant bg-surface px-md py-2.5 text-metadata font-semibold text-on-surface hover:bg-surface-container-low"
                  >
                    <Icon name="article" size={18} /> Open Transcript
                  </Link>
                </div>
              </article>

              {/* Recent meetings */}
              <article className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-md shadow-card">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-[17px] font-semibold text-on-surface">Recent Meetings</h3>
                  <Link to="/meetings" className="text-metadata font-semibold text-primary hover:underline">
                    View all meetings
                  </Link>
                </div>
                <ul className="divide-y divide-outline-variant">
                  {recent.map((ep) => {
                    const podcast = podcastById(ep.podcastId)
                    return (
                      <li key={ep.id}>
                        <Link to={`/meetings/${ep.id}`} className="group flex items-center gap-md py-2.5">
                          {podcast && <CoverTile podcast={podcast} className="h-10 w-10 shrink-0" />}
                          <span className="min-w-0 flex-1 truncate text-body-md font-medium text-on-surface group-hover:text-primary">
                            {ep.title}
                          </span>
                          <span className="hidden w-24 shrink-0 text-metadata text-secondary sm:block">
                            {longDate(ep.publishedAt)}
                          </span>
                          <span className="hidden w-14 shrink-0 text-metadata text-secondary md:block">
                            {formatDuration(ep.durationSec)}
                          </span>
                          <StatusBadge status={ep.status} />
                        </Link>
                      </li>
                    )
                  })}
                  {recent.length === 0 && (
                    <li className="py-6 text-center text-metadata text-secondary">
                      No meetings in {rangeLabel}.{' '}
                      <Link to="/meetings" className="font-semibold text-primary hover:underline">
                        View all
                      </Link>
                    </li>
                  )}
                </ul>
              </article>
            </>
          ) : (
            <div className="grid place-items-center gap-1 rounded-2xl border border-outline-variant bg-surface-container-lowest py-xl text-center">
              <Icon name="forum" size={30} className="mb-1 text-outline" />
              <p className="text-body-md text-secondary">
                {channel ? `No meetings from ${channel.title} yet.` : 'No meetings yet.'}
              </p>
              <p className="text-metadata text-outline">
                {isAdmin ? 'Recorded meetings will appear here.' : 'Send the notetaker to a meeting to get started.'}
              </p>
            </div>
          )}
        </div>

        {/* Right column */}
        <aside className="flex flex-col gap-gutter lg:col-span-4">
          {/* Recent activity */}
          <div className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-md shadow-card">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-[17px] font-semibold text-on-surface">
                <Icon name="monitoring" size={20} className="text-primary" /> Recent Activity
              </h3>
              <Link to="/meetings" className="text-metadata font-semibold text-primary hover:underline">
                View all
              </Link>
            </div>
            <ul className="flex flex-col gap-1">
              {activity.map((ep) => {
                const podcast = podcastById(ep.podcastId)
                const dot = ep.status === 'ready' ? 'bg-success' : ep.status === 'failed' ? 'bg-error' : 'bg-primary'
                return (
                  <li key={ep.id}>
                    <Link
                      to={`/meetings/${ep.id}`}
                      className="-mx-2 flex items-start gap-2.5 rounded-lg p-2 transition-colors hover:bg-surface-container-low"
                    >
                      {podcast && <CoverTile podcast={podcast} className="h-9 w-9 shrink-0" />}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-metadata font-semibold text-on-surface">{ep.title}</p>
                        <p className="truncate text-[13px] text-secondary">
                          {ep.entities.people.slice(0, 3).join(', ') || 'Transcript recorded'}
                        </p>
                        <p className="mt-0.5 text-[12px] text-outline">
                          {longDate(ep.publishedAt)} · {formatDuration(ep.durationSec)}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
                        <span className="text-[12px] text-outline">{relativeDate(ep.publishedAt)}</span>
                        <span className={`h-2 w-2 rounded-full ${dot}`} />
                      </div>
                    </Link>
                  </li>
                )
              })}
              {activity.length === 0 && (
                <li className="py-6 text-center text-metadata text-secondary">No activity in {rangeLabel}.</li>
              )}
            </ul>
          </div>

          {/* This week */}
          <div className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-md shadow-card">
            <h3 className="mb-3 flex items-center gap-2 text-[17px] font-semibold text-on-surface">
              <Icon name="calendar_month" size={20} className="text-primary" /> {preset.stat}
            </h3>
            <div className="grid grid-cols-3 gap-2 text-center">
              <Stat label="Meetings" value={stats.meetings} />
              <Stat label="Summaries" value={stats.summaries} />
              <Stat label="Participants" value={stats.participants} />
            </div>
            {topics.length > 0 && (
              <>
                <p className="mb-2 mt-md text-metadata font-medium text-on-surface">Top topics</p>
                <div className="flex flex-wrap gap-1.5">
                  {topics.map((t) => (
                    <Link
                      key={t.label}
                      to={`/search?q=${encodeURIComponent(t.label)}`}
                      title={`${t.count} mention${t.count === 1 ? '' : 's'} across your meetings`}
                      className="press rounded-full chip-signal px-2.5 py-1 text-[12px] font-medium hover:opacity-80"
                    >
                      {t.label}
                    </Link>
                  ))}
                </div>
              </>
            )}
            <Link
              to="/weekly"
              className="press mt-md flex items-center justify-center gap-2 rounded-lg border border-outline-variant py-2.5 text-metadata font-semibold text-primary hover:bg-surface-container-low"
            >
              <Icon name="bar_chart" size={18} /> View Weekly Summary
            </Link>
          </div>
        </aside>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-[26px] font-bold leading-none text-primary">{value}</p>
      <p className="mt-1.5 text-[11px] leading-tight text-secondary">{label}</p>
    </div>
  )
}
