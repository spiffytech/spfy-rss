/**
 * Feed icon acquisition: fetch the feed-declared icon (or the site favicon),
 * store the bytes. One icon per feed; browser does the scaling (no resize
 * step, per plan).
 */
import { eq } from 'drizzle-orm'

import type { FeedId, IconId } from '../../shared/ids'
import { epochMs, newIconId } from '../../shared/ids'
import type { ReaderHandle } from '../db'
import { feedIcons, icons } from '../db/schema'

const MAX_ICON_BYTES = 512 * 1024

export async function ensureFeedIcon(opts: {
  handle: ReaderHandle
  feedId: FeedId
  candidates: string[]
  now?: number
}): Promise<boolean> {
  const { db } = opts.handle
  const existing = db
    .select({ feedId: feedIcons.feedId })
    .from(feedIcons)
    .where(eq(feedIcons.feedId, opts.feedId))
    .get()
  if (existing) return true

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
