/**
 * View queries: one full display set per view, bodies included (one request and
 * one query per page), newest- or oldest-first per the resolved prefs. The hidden
 * filter predicate and the counters share one definition of "visible", and
 * soft-deleted rows never appear anywhere.
 */
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm'

import type { EntriesFilter } from '../../shared/filter'
import type { CategoryCount, EntrySummary, FeedInfo, FeedPanelResult } from '../../shared/types'
import { DEFAULT_HIDE_READ_ITEMS } from '../../shared/prefs'
import type { CategoryId, EntryId, FeedId, UserId } from '../../shared/ids'
import type { ReaderHandle } from '../db'
import { categories, entries, feedIcons, feeds } from '../db/schema'
import { translateSearch } from './search'

type Db = ReaderHandle['db']

/** First window of a view; scrolling to the end fetches the next. */
export const VIEW_PAGE_SIZE = 100

/**
 * The columns of an entry row, in one place: every read of an entry (a page of
 * the view, the rows a write touched) answers with exactly this shape. The body
 * is part of the row, so a page costs one request and one query.
 */
const entryColumns = {
  id: entries.id,
  feedId: entries.feedId,
  feedTitle: feeds.title,
  title: entries.title,
  url: entries.url,
  author: entries.author,
  publishedAt: entries.publishedAt,
  status: entries.status,
  starred: entries.starred,
  content: sql<string>`COALESCE(${entries.content}, '')`,
  readingTime: entries.readingTime,
  feedBaseUrl: sql<string | null>`COALESCE(${feeds.siteUrl}, ${feeds.feedUrl})` as SQL<string | null>,
} as const

/** Read rows sort after unread ones — the search view's primary key. */
const bucketOf = () => sql`CASE WHEN ${entries.status} = 'read' THEN 1 ELSE 0 END`

import type { ViewCursor } from '../../shared/types'
export type { ViewCursor }

function visibilityConditions(userId: UserId, filter: EntriesFilter): { where: SQL[]; order: SQL; bucketFirst: boolean } {
  const isSearch = (filter.search ?? '') !== ''
  const where: SQL[] = [
    eq(entries.userId, userId),
    sql`${entries.status} <> 'removed'`,
  ]

  // Search spans both buckets by default (the old app's search did); plain
  // views follow hideReadItems (default: unread only).
  const hideRead = isSearch ? filter.searchStatus === 'unread' : filter.hideReadItems ?? DEFAULT_HIDE_READ_ITEMS
  if (hideRead) where.push(eq(entries.status, 'unread'))
  if (filter.starred === true) where.push(eq(entries.starred, true))
  if (filter.feedId) where.push(eq(entries.feedId, filter.feedId as FeedId))
  if (filter.categoryId) {
    where.push(sql`${entries.feedId} IN (SELECT id FROM feeds WHERE category_id = ${filter.categoryId})`)
  }

  if (isSearch) {
    const q = translateSearch(filter.search!, { typeAhead: true })
    // MATCH's left operand must be the FTS5 table's name (its hidden column) —
    // an alias like `f MATCH` parses as a plain column reference and fails.
    if (q.kind === 'terms') {
      where.push(
        sql`EXISTS (SELECT 1 FROM entries_fts WHERE entries_fts.rowid = entries.rowid AND entries_fts MATCH ${q.match})`,
      )
    } else if (q.kind === 'exclusions') {
      where.push(
        sql`NOT EXISTS (SELECT 1 FROM entries_fts WHERE entries_fts.rowid = entries.rowid AND entries_fts MATCH ${q.match})`,
      )
    }
  }

  // Search is always newest-first (plan); other views honor the sort pref.
  const newestFirst = isSearch || filter.sort === 'newest'
  const time = newestFirst ? desc(entries.publishedAt) : asc(entries.publishedAt)
  const tie = newestFirst ? desc(entries.id) : asc(entries.id)
  // Search keeps the old app's unread-first buckets (its Miniflux cursor
  // paginated per bucket, and unread matches are what a search is usually
  // for). Within a bucket: newest first, exactly as before.
  const order = isSearch ? sql`${bucketOf()} ASC, ${time}, ${tie}` : sql`${time}, ${tie}`
  return { where, order, bucketFirst: isSearch }
}

export function queryView(
  db: Db,
  opts: { userId: UserId; filter: EntriesFilter; cursor?: ViewCursor | null; limit?: number },
): { entries: EntrySummary[]; nextCursor: ViewCursor | null } {
  const { where, order, bucketFirst } = visibilityConditions(opts.userId, opts.filter)
  const newestFirst = (opts.filter.search ?? '') !== '' ? true : opts.filter.sort === 'newest'
  const cursor = opts.cursor
  if (cursor) {
    // Keyset continuation on (published_at, id) — the same pair the ORDER BY
    // uses, so equal timestamps can't skip or repeat rows at the seam.
    where.push(
      bucketFirst
        ? sql`(${bucketOf()} > ${cursor.bucket ?? 0} OR (${bucketOf()} = ${cursor.bucket ?? 0} AND (${entries.publishedAt} < ${cursor.publishedAt} OR (${entries.publishedAt} = ${cursor.publishedAt} AND ${entries.id} < ${cursor.id}))))`
        : newestFirst
          ? sql`(${entries.publishedAt} < ${cursor.publishedAt} OR (${entries.publishedAt} = ${cursor.publishedAt} AND ${entries.id} < ${cursor.id}))`
          : sql`(${entries.publishedAt} > ${cursor.publishedAt} OR (${entries.publishedAt} = ${cursor.publishedAt} AND ${entries.id} > ${cursor.id}))`,
    )
  }
  const limit = opts.limit ?? VIEW_PAGE_SIZE
  const rows = db
    .select(entryColumns)
    .from(entries)
    .innerJoin(feeds, eq(entries.feedId, feeds.id))
    .where(and(...where))
    .orderBy(order)
    .limit(limit + 1)
    .all()

  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  const nextCursor: ViewCursor | null =
    rows.length > limit && last
      ? {
          publishedAt: last.publishedAt,
          id: last.id,
          ...(bucketFirst ? { bucket: (last.status === 'read' ? 1 : 0) as 0 | 1 } : {}),
        }
      : null
  return { entries: page, nextCursor }
}

/** The only fields a mutation changes: what the client applies in place of
 *  re-reading the window it is showing. */
export type WrittenRow = { id: EntryId; status: 'read' | 'unread'; starred: boolean }

/**
 * The mutation's answer: the rows it just wrote, without the body or the feed
 * fields. Read state is the client's to apply; it never re-reads the window.
 */
export function writtenRows(
  db: Db,
  opts: { userId: UserId; ids: EntryId[] },
): WrittenRow[] {
  if (opts.ids.length === 0) return []
  return db
    .select({ id: entries.id, status: entries.status, starred: entries.starred })
    .from(entries)
    .where(
      and(
        eq(entries.userId, opts.userId),
        inArray(entries.id, opts.ids),
        sql`${entries.status} <> 'removed'`,
      ),
    )
    .all() as WrittenRow[]
}

/** Sidebar snapshot: feeds, categories with totals, and per-feed unread counts. */
export function panel(
  db: Db,
  opts: { userId: UserId; hideEmptyFeeds: boolean; currentFeed?: FeedId | null },
): Omit<FeedPanelResult, 'userPrefs' | 'feedPrefs'> {
  const feedRows = db
    .select({
      id: feeds.id,
      categoryId: feeds.categoryId,
      title: feeds.title,
      siteUrl: feeds.siteUrl,
      feedUrl: feeds.feedUrl,
      checkedAt: feeds.checkedAt,
      parsingErrorCount: feeds.parsingErrorCount,
      lastError: feeds.lastError,
      lastErrorAt: feeds.lastErrorAt,
      iconId: feedIcons.iconId,
    })
    .from(feeds)
    .leftJoin(feedIcons, eq(feedIcons.feedId, feeds.id))
    .where(eq(feeds.userId, opts.userId))
    .orderBy(asc(feeds.title))
    .all()

  const counterRows = db
    .select({ feedId: entries.feedId, count: sql<number>`count(*)` })
    .from(entries)
    .innerJoin(feeds, eq(entries.feedId, feeds.id))
    .where(and(eq(entries.userId, opts.userId), eq(entries.status, 'unread'), sql`${entries.status} <> 'removed'`))
    .groupBy(entries.feedId)
    .all()

  const counters: Record<string, number> = {}
  for (const row of counterRows) counters[row.feedId] = row.count

  // Totals per category used to be computed here and never rendered: the sidebar
  // sums the per-feed counters instead, so there is one definition of the number.
  const categoryRows = db.select().from(categories).where(eq(categories.userId, opts.userId)).orderBy(asc(categories.title)).all()
  const categoryCounts: CategoryCount[] = categoryRows.map((c) => ({
    id: c.id as CategoryId,
    title: c.title,
  }))

  const toFeedInfo = (f: (typeof feedRows)[number]): FeedInfo => ({
    id: f.id,
    categoryId: f.categoryId,
    title: f.title,
    siteUrl: f.siteUrl,
    feedUrl: f.feedUrl,
    checkedAt: f.checkedAt,
    parsingErrorCount: f.parsingErrorCount,
    lastError: f.lastError,
    lastErrorAt: f.lastErrorAt,
    hasIcon: f.iconId !== null,
  })

  // The view's own feed stays in the list even with nothing unread: the sidebar
  // keeps the feed you are reading selected, and the header names it. The client
  // mirrors this with `!isActiveFeed(feed.id)` in its hiding rules. Fetch-error
  // state deliberately plays no part in visibility either way.
  const visibleFeeds: FeedInfo[] = feedRows
    .filter((f) => !opts.hideEmptyFeeds || (counters[f.id] ?? 0) > 0 || f.id === opts.currentFeed)
    .map(toFeedInfo)

  return {
    feeds: visibleFeeds,
    // Every feed, unfiltered. The sidebar uses `feeds` (empty ones hidden); the
    // home page needs to resolve favorites by id even when they have nothing
    // unread — a favorite is a bookmarked feed, not a queue.
    allFeeds: feedRows.map(toFeedInfo),
    categories: categoryCounts,
    counters: counters as Record<FeedId, number>,
  }
}
