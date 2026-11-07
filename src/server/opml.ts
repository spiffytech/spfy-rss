/**
 * OPML import/export.
 *
 * Flat folders: nested outlines are collapsed into one folder name joined with
 * " / " (e.g. `Tech / Blogs`). That keeps distinct source folders distinct
 * without inventing nesting in the app's model. A feed at the top level is
 * uncategorized.
 *
 * Imports do not fetch feeds. They are inserted due-now and the scheduler warms
 * them on its next ticks, so a large file answers immediately instead of holding
 * the request open for hundreds of HTTP fetches.
 */
import { eq } from 'drizzle-orm'
import { generateOpml, parseOpml } from 'feedsmith'

import { epochMs, newFeedId, type UserId } from '../shared/ids'
import type { OpmlImportResult } from '../shared/types'
import type { ReaderHandle } from './db'
import { categories, feeds } from './db/schema'
import { fallbackTitle, getOrCreateCategory } from './query/feed-admin'
import { normalizeFeedUrl } from './fetch/subscribe'

type Subscription = {
  title: string
  feedUrl: string
  siteUrl: string | null
  folder: string | null
}

type Outline = {
  text?: string
  title?: string
  xmlUrl?: string
  htmlUrl?: string
  outlines?: Outline[]
}

const MAX_OPML_BYTES = 5_000_000

function label(outline: Outline): string {
  return (outline.title ?? outline.text ?? '').trim()
}

function collect(outlines: readonly Outline[], path: readonly string[], out: Subscription[]): void {
  for (const outline of outlines) {
    const feedUrl = (outline.xmlUrl ?? '').trim()
    if (feedUrl !== '') {
      out.push({
        title: label(outline),
        feedUrl,
        siteUrl: (outline.htmlUrl ?? '').trim() || null,
        folder: path.length > 0 ? path.join(' / ') : null,
      })
      continue
    }
    const name = label(outline)
    const nextPath = name === '' ? path : [...path, name]
    if (outline.outlines && outline.outlines.length > 0) {
      collect(outline.outlines, nextPath, out)
    }
  }
}

export function parseSubscriptions(
  text: string,
): { ok: true; subscriptions: Subscription[] } | { ok: false } {
  if (text.length > MAX_OPML_BYTES) return { ok: false }
  let document: unknown
  try {
    document = parseOpml(text)
  } catch {
    return { ok: false }
  }
  const body = (document as { body?: { outlines?: Outline[] } }).body
  const subscriptions: Subscription[] = []
  collect(body?.outlines ?? [], [], subscriptions)
  return { ok: true, subscriptions }
}

export function importOpml(
  handle: ReaderHandle,
  opts: { userId: UserId; text: string; now?: number },
): OpmlImportResult {
  const parsed = parseSubscriptions(opts.text)
  if (!parsed.ok) {
    return { ok: false, reason: opts.text.length > MAX_OPML_BYTES ? 'too_large' : 'invalid_file' }
  }

  const now = opts.now ?? Date.now()
  const existing = new Set(
    handle.db
      .select({ feedUrl: feeds.feedUrl })
      .from(feeds)
      .where(eq(feeds.userId, opts.userId))
      .all()
      .map((row) => row.feedUrl),
  )

  let imported = 0
  let already = 0
  let invalid = 0

  for (const subscription of parsed.subscriptions) {
    const feedUrl = normalizeFeedUrl(subscription.feedUrl)
    if (feedUrl === null) {
      invalid++
      continue
    }
    if (existing.has(feedUrl)) {
      already++
      continue
    }

    const categoryId =
      subscription.folder === null
        ? null
        : getOrCreateCategory(handle, opts.userId, subscription.folder)
    const siteUrl = subscription.siteUrl === null ? null : normalizeFeedUrl(subscription.siteUrl)

    handle.db
      .insert(feeds)
      .values({
        id: newFeedId(epochMs(now)),
        userId: opts.userId,
        categoryId,
        title: fallbackTitle(subscription.title, feedUrl),
        feedUrl,
        siteUrl,
        nextCheckAt: epochMs(now),
        createdAt: epochMs(now),
      })
      .onConflictDoNothing()
      .run()
    existing.add(feedUrl)
    imported++
  }

  return { ok: true, imported, existing: already, invalid }
}

/** Grouped OPML 2.0. Uncategorized feeds become top-level outlines. */
export function exportOpml(handle: ReaderHandle, userId: UserId): string {
  const rows = handle.db
    .select({
      title: feeds.title,
      feedUrl: feeds.feedUrl,
      siteUrl: feeds.siteUrl,
      categoryTitle: categories.title,
    })
    .from(feeds)
    .leftJoin(categories, eq(categories.id, feeds.categoryId))
    .where(eq(feeds.userId, userId))
    .all()

  const folders = new Map<string, typeof rows>()
  const loose: typeof rows = []
  for (const row of rows) {
    if (row.categoryTitle === null) {
      loose.push(row)
      continue
    }
    const list = folders.get(row.categoryTitle) ?? []
    list.push(row)
    folders.set(row.categoryTitle, list)
  }

  const byTitle = (a: { title: string }, b: { title: string }) =>
    a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })

  const outlines = [
    ...[...folders.entries()]
      .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      .map(([title, list]) => ({
        text: title,
        title,
        outlines: [...list].sort(byTitle).map((feed) => ({
          text: feed.title,
          title: feed.title,
          type: 'rss',
          xmlUrl: feed.feedUrl,
          ...(feed.siteUrl === null ? {} : { htmlUrl: feed.siteUrl }),
        })),
      })),
    ...[...loose].sort(byTitle).map((feed) => ({
      text: feed.title,
      title: feed.title,
      type: 'rss',
      xmlUrl: feed.feedUrl,
      ...(feed.siteUrl === null ? {} : { htmlUrl: feed.siteUrl }),
    })),
  ]

  return generateOpml({
    head: { title: 'Miniflux Reader', dateCreated: new Date() },
    body: { outlines },
  })
}
