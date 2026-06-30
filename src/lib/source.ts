import type { Episode, Podcast } from './types'

function isYouTubeUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    return host === 'youtube.com' || host === 'youtu.be' || host.endsWith('.youtube.com')
  } catch {
    return false
  }
}

// The episode's link at its origin. Real per-episode URLs slot into
// `episode.sourceUrl`, but only when they match the button's destination: a
// YouTube-surfaced show (e.g. All-In) whose RSS <link> points to libsyn must not
// send a "Watch on YouTube" click to libsyn. When there's no matching link, we
// search the source platform for the exact show + episode title, so the button
// always lands on the right platform.

export function episodeSourceUrl(
  episode: Pick<Episode, 'title' | 'sourceUrl'>,
  podcast?: Pick<Podcast, 'title' | 'source'>,
): string {
  const youtube = podcast?.source === 'youtube'
  if (episode.sourceUrl && (!youtube || isYouTubeUrl(episode.sourceUrl))) {
    return episode.sourceUrl
  }
  const q = encodeURIComponent(`${podcast?.title ?? ''} ${episode.title}`.trim())
  return youtube
    ? `https://www.youtube.com/results?search_query=${q}`
    : `https://podcasts.apple.com/us/search?term=${q}`
}

const idish = (s?: string | null) => (s && /^[\w-]{6,}$/.test(s) ? s : null)

/** The YouTube video id behind an episode's sourceUrl, when it links straight to
 *  a video. Drives the in-app player: youtube.com itself refuses to render in
 *  embedded contexts (X-Frame-Options), so wherever we have an id we play via
 *  the /embed/ endpoint instead of navigating — which works even when the whole
 *  app is running inside someone else's (sandboxed) iframe. */
export function youtubeVideoId(episode: Pick<Episode, 'sourceUrl'>): string | null {
  const url = episode.sourceUrl
  if (!url) return null
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, '').toLowerCase()
    if (host === 'youtu.be') return idish(u.pathname.split('/').filter(Boolean)[0])
    if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
      const v = u.searchParams.get('v')
      if (v) return idish(v)
      const m = u.pathname.match(/\/(?:shorts|embed|live)\/([\w-]{6,})/)
      if (m) return idish(m[1])
    }
  } catch {
    /* not a URL */
  }
  return null
}

export function sourceLabel(podcast?: Pick<Podcast, 'source'>): string {
  return podcast?.source === 'youtube' ? 'Watch on YouTube' : 'Listen on Apple Podcasts'
}

export function sourceIcon(podcast?: Pick<Podcast, 'source'>): string {
  return podcast?.source === 'youtube' ? 'smart_display' : 'podcasts'
}
