/**
 * Reader schema (SQLite via bun:sqlite + Drizzle query builder).
 *
 * Conventions:
 * - PKs are UUIDv7 strings seeded from `created_at` (see src/shared/ids.ts).
 * - Time columns are epoch-ms integers (`EpochMs`) — plain `integer()`, mode
 *   number, so values cross the JSON boundary unchanged.
 * - Migration `0000` is the baseline: `user_prefs` exactly as the old app's
 *   prefs side-DB defined it (src/server/lib/prefs.ts there), except
 *   `user_id` is TEXT here because user keys are UUIDv7 (the old integer
 *   Miniflux ids are remapped at import). Scopes stay `user` and `feed:<id>`;
 *   per-feed filter lists live inside the feed-scope prefs JSON.
 * - Deletion is soft: `entries.status='removed'` rows stay, so
 *   `UNIQUE(feed_id, hash)` keeps matching and a refetch can never resurrect.
 *   A tombstone table earns its keep only alongside a future hard-delete
 *   cleanup job.
 * - `entries_fts` (migration `0001`, hand-added — drizzle-kit does not model
 *   FTS5 virtual tables) is an external-content index over
 *   `entries(title, content)`, maintained by the app through
 *   src/server/db/search-sync.ts (the only entry write sites are the import
 *   and the fetch pipeline).
 * - Drizzle query builder only (`.all()/.get()/.run()`, sync throughout) — no
 *   relational `db.query.*` API.
 */
import type {
  CategoryId,
  EntryId,
  EntryStatus,
  EpochMs,
  FeedId,
  IconId,
  UserId,
} from '../../shared/ids'
import {
  blob,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: text('id').$type<UserId>().primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: integer('created_at').$type<EpochMs>().notNull(),
})

export const categories = sqliteTable(
  'categories',
  {
    id: text('id').$type<CategoryId>().primaryKey(),
    userId: text('user_id')
      .$type<UserId>()
      .notNull()
      .references(() => users.id),
    title: text('title').notNull(),
    createdAt: integer('created_at').$type<EpochMs>().notNull(),
  },
  (t) => [uniqueIndex('categories_user_title_uq').on(t.userId, t.title)],
)

export const feeds = sqliteTable(
  'feeds',
  {
    id: text('id').$type<FeedId>().primaryKey(),
    userId: text('user_id')
      .$type<UserId>()
      .notNull()
      .references(() => users.id),
    /** Null means the feed is uncategorized. Folders stay flat. */
    categoryId: text('category_id')
      .$type<CategoryId>()
      .references(() => categories.id),
    title: text('title').notNull(),
    feedUrl: text('feed_url').notNull(),
    siteUrl: text('site_url'),
    // Fetch continuity: conditional-GET headers, last check time, and the
    // error streak Miniflux kept per feed.
    etagHeader: text('etag_header'),
    lastModifiedHeader: text('last_modified_header'),
    checkedAt: integer('checked_at').$type<EpochMs>(),
    parsingErrorCount: integer('parsing_error_count').notNull().default(0),
    /** Scheduler: committed next-fetch target (epoch-ms) and the origin's
     *  floor from Retry-After / cache freshness (epoch-ms). */
    nextCheckAt: integer('next_check_at').$type<EpochMs>(),
    fetchAfterAt: integer('fetch_after_at').$type<EpochMs>(),
    /** WebSub: the hub this feed advertises, and when our lease on it expires.
     *  A feed with no hub simply has nulls and stays on polling. */
    websubHub: text('websub_hub'),
    websubLeaseUntil: integer('websub_lease_until').$type<EpochMs>(),
    /** Unguessable per-feed token: /api/websub/<token> is the public callback.
     *  Also the HMAC secret the hub signs notifications with. */
    websubToken: text('websub_token'),
    /** The last fetch/parse failure, cleared by the next successful ingest.
     *  Shown (with its timestamp and the error streak) on the feed's warning. */
    lastError: text('last_error'),
    lastErrorAt: integer('last_error_at').$type<EpochMs>(),
    /** Last icon acquisition attempt (epoch-ms). Null = never tried. Recording
     *  the attempt makes "no icon found" a fact that retries weekly instead of
     *  an absence that costs two outbound requests on every poll. */
    iconCheckedAt: integer('icon_checked_at').$type<EpochMs>(),
    createdAt: integer('created_at').$type<EpochMs>().notNull(),
  },
  (t) => [
    uniqueIndex('feeds_user_url_uq').on(t.userId, t.feedUrl),
    index('feeds_user_idx').on(t.userId),
  ],
)

export const entries = sqliteTable(
  'entries',
  {
    id: text('id').$type<EntryId>().primaryKey(),
    userId: text('user_id')
      .$type<UserId>()
      .notNull()
      .references(() => users.id),
    feedId: text('feed_id')
      .$type<FeedId>()
      .notNull()
      .references(() => feeds.id),
    // Miniflux's SHA-256 identity hash (ported recipe) — the natural key that
    // dedups at insert and survives soft deletes. Stored verbatim at import.
    hash: text('hash').notNull(),
    title: text('title').notNull(),
    url: text('url'),
    author: text('author'),
    // Raw feed HTML, unmodified. ALL transforms happen at display time.
    content: text('content').notNull(),
    publishedAt: integer('published_at').$type<EpochMs>().notNull(),
    createdAt: integer('created_at').$type<EpochMs>().notNull(),
    changedAt: integer('changed_at').$type<EpochMs>().notNull(),
    status: text('status').$type<EntryStatus>().notNull().default('unread'),
    starred: integer('starred', { mode: 'boolean' }).notNull().default(false),
    // MF-computed minutes; surfaced only when above the display threshold.
    readingTime: integer('reading_time').$type<number>().notNull().default(0),
    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
  },
  (t) => [
    uniqueIndex('entries_feed_hash_uq').on(t.feedId, t.hash),
    index('entries_user_status_published_idx').on(t.userId, t.status, t.publishedAt),
    index('entries_feed_published_idx').on(t.feedId, t.publishedAt),
  ],
)

export const icons = sqliteTable('icons', {
  id: text('id').$type<IconId>().primaryKey(),
  mimeType: text('mime_type').notNull(),
  data: blob('data').$type<Uint8Array>().notNull(),
})

export const feedIcons = sqliteTable('feed_icons', {
  feedId: text('feed_id')
    .$type<FeedId>()
    .primaryKey()
    .references(() => feeds.id),
  iconId: text('icon_id')
    .$type<IconId>()
    .notNull()
    .references(() => icons.id),
})

export const userPrefs = sqliteTable(
  'user_prefs',
  {
    userId: text('user_id').$type<UserId>().notNull(),
    scope: text('scope').notNull(),
    prefs: text('prefs').notNull().default('{}'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.scope] })],
)
