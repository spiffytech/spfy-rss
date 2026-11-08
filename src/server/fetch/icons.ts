/**
 * Feed icon acquisition: fetch the feed-declared icon (or the site favicon),
 * store the bytes. One icon per feed; browser does the scaling (no resize
 * step, per plan).
 */
import { eq } from 'drizzle-orm'

import type { FeedId, IconId } from '../../shared/ids'
import { epochMs, newIconId } from '../../shared/ids'
import type { ReaderHandle } from '../db'
import { feedIcons, feeds, icons } from '../db/schema'

const MAX_ICON_BYTES = 512 * 1024
/** How long a failed attempt is trusted before trying again. */
const RETRY_MS = 7 * 86_400_000

export async function ensureFeedIcon(opts: {
  handle: ReaderHandle
  feedId: FeedId
  candidates: string[]
  now?: number
  /** Skip the retry window — a manual save is an explicit ask to try now. */
  force?: boolean
}): Promise<boolean> {
  const { db } = opts.handle
  const existing = db
    .select({ feedId: feedIcons.feedId })
    .from(feedIcons)
    .where(eq(feedIcons.feedId, opts.feedId))
    .get()
  if (existing) return true

  const feed = db
    .select({ iconCheckedAt: feeds.iconCheckedAt })
    .from(feeds)
    .where(eq(feeds.id, opts.feedId))
    .get()
  if (!feed) return false
  const now = opts.now ?? Date.now()
  if (!opts.force && feed.iconCheckedAt != null && now - feed.iconCheckedAt < RETRY_MS) return false
  // Stamp the attempt before the network can fail: one try per window whatever
  // happens next, so an iconless feed stops costing requests on every poll.
  db.update(feeds)
    .set({ iconCheckedAt: epochMs(now) })
    .where(eq(feeds.id, opts.feedId))
    .run()

  for (const url of opts.candidates) {
    if (!url) continue
    try {
      const response = await fetch(url, {
        headers: { accept: 'image/*' },
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) continue
      const mimeType = response.headers.get('content-type') ?? ''
      if (!mimeType.startsWith('image/')) continue
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_ICON_BYTES) continue

      const iconId: IconId = newIconId(epochMs(opts.now ?? Date.now()))
      db.insert(icons).values({ id: iconId, mimeType, data: bytes }).run()
      db.insert(feedIcons).values({ feedId: opts.feedId, iconId }).onConflictDoNothing().run()
      return true
    } catch {
      // try the next candidate
    }
  }
  return false
}
