/**
 * Feed administration on the DB side: folder resolution, insert-with-ingest,
 * and the feed-row half of an edit. Network work (fetch, discovery, icons) is
 * invoked from here too, because "add a feed" and "change its URL" both mean
 * fetch first, then write.
 */
import { and, eq } from 'drizzle-orm'

import {
  epochMs,
  newCategoryId,
  newFeedId,
  type CategoryId,
  type FeedId,
  type UserId,
} from '../../shared/ids'
import type { FeedSaveError } from '../../shared/types'
import type { ReaderHandle } from '../db'
import { categories, feedIcons, feeds } from '../db/schema'
import { ingestFeedOutcome } from '../fetch/fetch-feed'
import { ensureFeedIcon } from '../fetch/icons'
import type { ParsedFeed } from '../fetch/parse'
import type { FetchOutcome } from '../fetch/transport'

type OkOutcome = Extract<FetchOutcome, { kind: 'ok' }>

/** Folder lookup: an id, a new title, or neither (= uncategorized). */
export type FolderChoice = {
  categoryId?: string | null | undefined
  newCategoryTitle?: string | undefined
}

export type FolderResult =
  { ok: true; categoryId: CategoryId | null } | { ok: false; reason: FeedSaveError }

export function resolveFolder(
  handle: ReaderHandle,
  userId: UserId,
  choice: FolderChoice,
): FolderResult {
  if (choice.newCategoryTitle !== undefined) {
    return { ok: true, categoryId: getOrCreateCategory(handle, userId, choice.newCategoryTitle) }
  }
  if (choice.categoryId == null || choice.categoryId === '') {
    return { ok: true, categoryId: null }
  }
  const owned = handle.db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.id, choice.categoryId as CategoryId), eq(categories.userId, userId)))
    .get()
  return owned ? { ok: true, categoryId: owned.id } : { ok: false, reason: 'folder' }
}

/** Folders are flat and titles are unique per user: an existing title wins. */
export function getOrCreateCategory(
  handle: ReaderHandle,
  userId: UserId,
  title: string,
): CategoryId {
  const trimmed = title.trim()
  const existing = handle.db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.userId, userId), eq(categories.title, trimmed)))
    .get()
  if (existing) return existing.id

  const id = newCategoryId(epochMs(Date.now()))
  handle.db
    .insert(categories)
    .values({ id, userId, title: trimmed, createdAt: epochMs(Date.now()) })
    .run()
  return id
}

export function feedIdByUrl(handle: ReaderHandle, userId: UserId, feedUrl: string): FeedId | null {
  const row = handle.db
    .select({ id: feeds.id })
    .from(feeds)
    .where(and(eq(feeds.userId, userId), eq(feeds.feedUrl, feedUrl)))
    .get()
  return row?.id ?? null
}

export function ownedFeed(
  handle: ReaderHandle,
  userId: UserId,
  feedId: FeedId,
): typeof feeds.$inferSelect | undefined {
  return handle.db
    .select()
    .from(feeds)
    .where(and(eq(feeds.id, feedId), eq(feeds.userId, userId)))
    .get()
}

/** Best-effort icon fetch; never lets an unreachable favicon fail the save. */
export async function fetchIconFor(
  handle: ReaderHandle,
  feedId: FeedId,
  parsed: ParsedFeed,
  finalUrl: string,
): Promise<void> {
  const origin = (() => {
    try {
      return new URL(parsed.siteUrl ?? finalUrl).origin
    } catch {
      return null
    }
  })()
  try {
    await ensureFeedIcon({
      handle,
      feedId,
      // Adding or saving a feed is an explicit ask: try even if a recent poll
      // already used this feed's weekly attempt.
      force: true,
      candidates: [parsed.iconUrl, origin === null ? null : `${origin}/favicon.ico`].filter(
        (candidate): candidate is string => candidate !== null,
      ),
    })
  } catch {
    // the feed is stored; a missing icon degrades to the letter tile
  }
}

/** Insert a new subscription and ingest the document that validated it. */
export function insertSubscription(
  handle: ReaderHandle,
  opts: {
    userId: UserId
    categoryId: CategoryId | null
    title: string
    feedUrl: string
    siteUrl: string | null
    outcome: OkOutcome
    parsed: ParsedFeed
    now?: number
  },
): FeedId {
  const now = opts.now ?? Date.now()
  const id = newFeedId(epochMs(now))
  handle.db
    .insert(feeds)
    .values({
      id,
      userId: opts.userId,
      categoryId: opts.categoryId,
      title: opts.title,
      feedUrl: opts.feedUrl,
      siteUrl: opts.siteUrl,
      createdAt: epochMs(now),
    })
    .run()
  ingestFeedOutcome({ handle, feedId: id, outcome: opts.outcome, now })
  return id
}

/**
 * Apply an edit. A URL change resets every piece of fetch continuity — the new
 * document's conditional-GET headers must not be compared against the old
 * origin's — and drops the old icon so the next fetch can replace it.
 */
export function updateFeedRow(
  handle: ReaderHandle,
  opts: {
    userId: UserId
    feedId: FeedId
    title: string
    categoryId: CategoryId | null
    feedUrl: string
    siteUrl: string | null
    outcome?: OkOutcome
    now?: number
  },
): void {
  const now = opts.now ?? Date.now()
  const changedUrl = opts.outcome !== undefined
  handle.db
    .update(feeds)
    .set({
      title: opts.title,
      categoryId: opts.categoryId,
      feedUrl: opts.feedUrl,
      ...(changedUrl
        ? {
            siteUrl: opts.siteUrl,
            etagHeader: opts.outcome!.etag,
            lastModifiedHeader: opts.outcome!.lastModified,
            parsingErrorCount: 0,
            nextCheckAt: null,
            fetchAfterAt: null,
            websubHub: null,
            websubLeaseUntil: null,
            websubToken: null,
          }
        : {}),
    })
    .where(and(eq(feeds.id, opts.feedId), eq(feeds.userId, opts.userId)))
    .run()

  if (!changedUrl) return
  handle.db.delete(feedIcons).where(eq(feedIcons.feedId, opts.feedId)).run()
  ingestFeedOutcome({ handle, feedId: opts.feedId, outcome: opts.outcome!, now })
}

/** Title fallback: the feed's own title, else its host, else the URL. */
export function fallbackTitle(parsedTitle: string, feedUrl: string): string {
  const title = parsedTitle.trim()
  if (title !== '') return title
  try {
    return new URL(feedUrl).hostname || feedUrl
  } catch {
    return feedUrl
  }
}
