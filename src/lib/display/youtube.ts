/**
 * YouTube embed detection → `<lite-youtube>` (pure; the DOM walk in render.ts
 * is the only consumer). Accepts the URL shapes feeds actually ship:
 * watch?v=, youtu.be/, /embed/, /shorts/, /v/.
 */
export type YouTubeEmbed = {
  videoId: string
  /** lite-youtube `params` (player query string: start, list, t… minus v). */
  params: string
}

const VIDEO_ID = /^[A-Za-z0-9_-]{6,15}$/

export function parseYouTubeUrl(rawUrl: string): YouTubeEmbed | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  const host = url.hostname.replace(/^(www|m|music)\./, '')
  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com' && host !== 'youtu.be') return null

  let videoId = ''
  if (host === 'youtu.be') {
    videoId = url.pathname.split('/').filter(Boolean)[0] ?? ''
  } else {
    const path = url.pathname.split('/').filter(Boolean)
    if (path[0] === 'watch') videoId = url.searchParams.get('v') ?? ''
    else if (path[0] === 'embed' || path[0] === 'shorts' || path[0] === 'v' || path[0] === 'live')
      videoId = path[1] ?? ''
  }
  if (!VIDEO_ID.test(videoId)) return null

  // Keep playback-shaping params only.
  const params = new URLSearchParams()
  for (const key of ['start', 't', 'list', 'index']) {
    const value = url.searchParams.get(key)
    if (value !== null) params.set(key, value)
  }
  return { videoId, params: params.toString() }
}
