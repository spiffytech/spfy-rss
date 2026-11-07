/**
 * Mutations: mark-read is explicit-ID only (exactly the IDs a view fetched to
 * display — hidden rows are never in that set, late arrivals untouched), and
 * prefs writes are shallow merges into the scope JSON.
 */
import { and, eq, inArray, sql } from 'drizzle-orm'

import type { SQLQueryBindings } from 'bun:sqlite'

import type { EntriesFilter } from '../../shared/filter'
import type { FeedPrefs, UserPrefs } from '../../shared/prefs'
import { feedScope, userScope } from '../../shared/prefs'
import type { EntryId, EntryStatus, FeedId, UserId } from '../../shared/ids'
import type { ReaderHandle } from '../db'
import { entries, feedIcons, feeds, userPrefs } from '../db/schema'
import { syncEntrySearch, type SearchRow } from '../db/search-sync'

type Db = ReaderHandle['db']
type MarkStatus = Exclude<EntryStatus, 'removed'>

export function markEntries(
  db: Db,
  opts: { userId: UserId; entryIds: EntryId[]; status: MarkStatus },
): number {
  if (opts.entryIds.length === 0) return 0
  return db
    .update(entries)
    .set({ status: opts.status })
    .where(
      and(
        eq(entries.userId, opts.userId),
        inArray(entries.id, opts.entryIds),
        sql`${entries.status} <> 'removed'`,
      ),
    )
    .returning({ id: entries.id })
    .all().length
}

/**
 * Hard-unsubscribe. Two invariants here:
 *
 * - Children before the parent: entries AND feed_icons both have FKs to feeds
 *   with no ON DELETE CASCADE (and `foreign_keys` is ON), so the feed row goes
 *   last. (The shared `icons` rows are byte-deduped across feeds — left for
 *   GC, never deleted here.)
 * - The FTS index is app-maintained (no triggers — see db/search-sync.ts), so
 *   every removed entry's index row is deleted first with the same
 *   before-values protocol ingest uses. Skipping that orphans index rows and
 *   search returns ghosts.
 *
 * Returns false when the feed does not exist for this user (endpoint → 404).
 */
export function unsubscribeFeed(
  h: ReaderHandle,
  opts: { userId: UserId; feedId: FeedId },
): boolean {
  const owned = h.db
    .select({ id: feeds.id })
    .from(feeds)
    .where(and(eq(feeds.id, opts.feedId), eq(feeds.userId, opts.userId)))
    .get()
  if (!owned) return false
  const rows = h.sqlite
    .query<SearchRow, SQLQueryBindings[]>(
      'SELECT rowid, title, content FROM entries WHERE feed_id = ?',
    )
    .all(opts.feedId)
  h.sqlite.transaction(() => {
    for (const row of rows) syncEntrySearch(h.sqlite, row, null)
    h.db.delete(entries).where(eq(entries.feedId, opts.feedId)).run()
    h.db.delete(feedIcons).where(eq(feedIcons.feedId, opts.feedId)).run()
    h.db
      .delete(userPrefs)
      .where(eq(userPrefs.scope, feedScope(opts.feedId)))
      .run()
    h.db.delete(feeds).where(eq(feeds.id, opts.feedId)).run()
  })()
  return true
}

export function setStarred(
  db: Db,
  opts: { userId: UserId; entryIds: EntryId[]; starred: boolean },
): number {
  if (opts.entryIds.length === 0) return 0
  return db
    .update(entries)
    .set({ starred: opts.starred })
    .where(
      and(
        eq(entries.userId, opts.userId),
        inArray(entries.id, opts.entryIds),
        sql`${entries.status} <> 'removed'`,
      ),
    )
    .returning({ id: entries.id })
    .all().length
}

// --- preferences -----------------------------------------------------------

function readScope(db: Db, userId: UserId, scope: string): Record<string, unknown> {
  const row = db
    .select({ prefs: userPrefs.prefs })
    .from(userPrefs)
    .where(and(eq(userPrefs.userId, userId), eq(userPrefs.scope, scope)))
    .get()
  if (!row) return {}
  try {
    return JSON.parse(row.prefs) as Record<string, unknown>
  } catch {
    return {}
  }
}

function writeScope(db: Db, userId: UserId, scope: string, prefs: Record<string, unknown>): void {
  const json = JSON.stringify(prefs)
  db.insert(userPrefs)
    .values({ userId, scope, prefs: json })
    .onConflictDoUpdate({ target: [userPrefs.userId, userPrefs.scope], set: { prefs: json } })
    .run()
}

export function getUserPrefs(db: Db, userId: UserId): UserPrefs {
  return readScope(db, userId, userScope()) as UserPrefs
}

export function setUserPrefs(db: Db, userId: UserId, patch: Partial<UserPrefs>): UserPrefs {
  const next = { ...readScope(db, userId, userScope()), ...patch }
  writeScope(db, userId, userScope(), next)
  return next as UserPrefs
}

export function getAllFeedPrefs(db: Db, userId: UserId): Record<FeedId, FeedPrefs> {
  const rows = db
    .select({ scope: userPrefs.scope, prefs: userPrefs.prefs })
    .from(userPrefs)
    .where(and(eq(userPrefs.userId, userId), sql`${userPrefs.scope} LIKE 'feed:%'`))
    .all()
  const out: Record<string, FeedPrefs> = {}
  for (const row of rows) {
    const feedId = row.scope.slice('feed:'.length)
    try {
      out[feedId] = JSON.parse(row.prefs) as FeedPrefs
    } catch {
      out[feedId] = {}
    }
  }
  return out as Record<FeedId, FeedPrefs>
}

export function setFeedPrefs(
  db: Db,
  userId: UserId,
  feedId: FeedId,
  patch: Partial<FeedPrefs>,
): FeedPrefs {
  const scope = feedScope(feedId)
  const next = { ...readScope(db, userId, scope), ...patch }
  writeScope(db, userId, scope, next)
  return next as FeedPrefs
}

export type { EntriesFilter }
