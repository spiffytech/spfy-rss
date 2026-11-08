/**
 * Stage 2 of the Miniflux import: JSONL dump → reader SQLite.
 *
 * Cutover-time operation (Miniflux is stopped first; the dump is frozen).
 * Idempotent: natural keys are matched first and existing rows are KEPT
 * (`ON CONFLICT DO NOTHING` semantics), so a re-run — or a later run after the
 * fetch pipeline has touched rows — never regresses app state.
 *
 * ID remapping: Miniflux integer ids → UUIDv7 (seeded from each row's own
 * `created_at`, falling back to `published_at`/`deleted_at`, else the run
 * time). Natural keys: username, (user, title) for categories, (user,
 * feed_url) for feeds, (feed_id, hash) for entries, icon bytes for icons,
 * (user, scope) for prefs.
 *
 * Deletion memory (verified against Miniflux source): `entry_tombstones`
 * rows and any surviving `status='removed'` rows import as `status='removed'`
 * rows; tombstones become stub entries (empty title/content) so
 * `UNIQUE(feed_id, hash)` keeps every deleted hash from re-entering.
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { and, eq } from 'drizzle-orm'

import {
  epochMs,
  newCategoryId,
  newEntryId,
  newFeedId,
  newIconId,
  newUserId,
  type FeedId,
  type UserId,
} from '../../shared/ids'
import type { ReaderHandle } from '../db'
import { categories, entries, feedIcons, feeds, icons, userPrefs, users } from '../db/schema'
import { rebuildEntrySearch } from '../db/search-sync'
import {
  mfCategory,
  mfEntry,
  mfFeed,
  mfFeedIcon,
  mfIcon,
  mfTombstone,
  mfUser,
  normalizeStatus,
  type MfEntry,
  type MfFeed,
} from './mf-rows'

export type LoadReport = {
  users: number
  categories: number
  feeds: number
  entries: number
  stubs: number
  icons: number
  feedIcons: number
  prefs: number
  skipped: { orphanEntries: number; orphanTombstones: number; orphanPrefs: number }
}

type RowSchema<T> = { parse(value: unknown): T }

function readRows<T>(dumpDir: string, table: string, schema: RowSchema<T>): T[] {
  const path = join(dumpDir, `${table}.jsonl`)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => schema.parse(JSON.parse(line)))
}

export function loadFromDump(opts: {
  handle: ReaderHandle
  dumpDir: string
  prefsDbPath?: string
  now?: number
}): LoadReport {
  const now = opts.now ?? Date.now()
  const report: LoadReport = {
    users: 0,
    categories: 0,
    feeds: 0,
    entries: 0,
    stubs: 0,
    icons: 0,
    feedIcons: 0,
    prefs: 0,
    skipped: { orphanEntries: 0, orphanTombstones: 0, orphanPrefs: 0 },
  }

  const { sqlite, db } = opts.handle
  const userMap = new Map<number, UserId>()
  const categoryMap = new Map<number, ReturnType<typeof newCategoryId>>()
  const feedMap = new Map<number, FeedId>()
  const feedOwner = new Map<number, UserId>()
  const iconMap = new Map<number, ReturnType<typeof newIconId>>()

  const run = sqlite.transaction(() => {
    // --- users (natural key: username; password set later via set-password) ---
    for (const row of readRows(opts.dumpDir, 'users', mfUser)) {
      const username = row.username.toLowerCase()
      const existing = db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, username))
        .get()
      if (existing) {
        userMap.set(row.id, existing.id)
        continue
      }
      const id = newUserId(epochMs(row.created_at ?? now))
      db.insert(users)
        .values({ id, username, passwordHash: '', createdAt: epochMs(row.created_at ?? now) })
        .run()
      userMap.set(row.id, id)
      report.users++
    }

    // --- categories (natural key: user + title) ---
    for (const row of readRows(opts.dumpDir, 'categories', mfCategory)) {
      const userId = userMap.get(row.user_id)
      if (!userId) continue
      const existing = db
        .select({ id: categories.id })
        .from(categories)
        .where(and(eq(categories.userId, userId), eq(categories.title, row.title)))
        .get()
      if (existing) {
        categoryMap.set(row.id, existing.id)
        continue
      }
      const id = newCategoryId(epochMs(row.created_at ?? now))
      db.insert(categories)
        .values({ id, userId, title: row.title, createdAt: epochMs(row.created_at ?? now) })
        .run()
      categoryMap.set(row.id, id)
      report.categories++
    }

    // --- feeds (natural key: user + feed_url) ---
    for (const row of readRows(opts.dumpDir, 'feeds', mfFeed)) {
      const userId = userMap.get(row.user_id)
      const categoryId = categoryMap.get(row.category_id)
      if (!userId || !categoryId) continue
      const existing = db
        .select({ id: feeds.id })
        .from(feeds)
        .where(and(eq(feeds.userId, userId), eq(feeds.feedUrl, row.feed_url)))
        .get()
      if (existing) {
        feedMap.set(row.id, existing.id)
        feedOwner.set(row.id, userId)
        continue
      }
      const id = newFeedId(epochMs(row.created_at ?? row.checked_at ?? now))
      db.insert(feeds)
        .values({
          id,
          userId,
          categoryId,
          title: row.title,
          feedUrl: row.feed_url,
          siteUrl: row.site_url ?? null,
          etagHeader: row.etag_header ?? null,
          lastModifiedHeader: row.last_modified_header ?? null,
          checkedAt: row.checked_at == null ? null : epochMs(row.checked_at),
          parsingErrorCount: row.parsing_error_count ?? 0,
          createdAt: epochMs(row.created_at ?? row.checked_at ?? now),
        })
        .run()
      feedMap.set(row.id, id)
      feedOwner.set(row.id, userId)
      report.feeds++
    }

    // --- entries (natural key: feed_id + hash; rows kept on re-run) ---
    for (const row of readRows(opts.dumpDir, 'entries', mfEntry)) {
      const feedId = feedMap.get(row.feed_id)
      const userId = userMap.get(row.user_id) ?? feedOwner.get(row.feed_id)
      if (!feedId || !userId) {
        report.skipped.orphanEntries++
        continue
      }
      const createdAt = epochMs(row.created_at ?? row.published_at)
      const inserted = db
        .insert(entries)
        .values({
          id: newEntryId(createdAt),
          userId,
          feedId,
          hash: row.hash,
          title: row.title ?? '',
          url: row.url ?? null,
          author: row.author ?? null,
          content: row.content ?? '',
          publishedAt: epochMs(row.published_at),
          createdAt,
          changedAt: epochMs(row.changed_at ?? row.published_at),
          status: normalizeStatus(row.status),
          starred: row.starred === true,
          readingTime: row.reading_time ?? 0,
          tags: row.tags ?? [],
        })
        .onConflictDoNothing()
        .returning({ id: entries.id })
        .all()
      // A re-run matches every natural key and inserts nothing. Report what
      // landed, not what was attempted, or a no-op looks like a full import.
      if (inserted.length > 0) report.entries++
    }

    // --- entry_tombstones → stub entries (the anti-resurrection set) ---
    for (const row of readRows(opts.dumpDir, 'entry_tombstones', mfTombstone)) {
      const feedId = feedMap.get(row.feed_id)
      const userId = feedOwner.get(row.feed_id)
      if (!feedId || !userId) {
        report.skipped.orphanTombstones++
        continue
      }
      const deletedAt = epochMs(row.deleted_at ?? now)
      const inserted = db
        .insert(entries)
        .values({
          id: newEntryId(deletedAt),
          userId,
          feedId,
          hash: row.hash,
          title: '',
          url: null,
          author: null,
          content: '',
          publishedAt: deletedAt,
          createdAt: deletedAt,
          changedAt: deletedAt,
          status: 'removed',
          starred: false,
          readingTime: 0,
          tags: [],
        })
        .onConflictDoNothing()
        .returning({ id: entries.id })
        .all()
      if (inserted.length > 0) report.stubs++
    }

    // --- icons (dedupe on bytes; MF's own hash column stays behind) ---
    for (const row of readRows(opts.dumpDir, 'icons', mfIcon)) {
      const bytes = new Uint8Array(Buffer.from(row.content.$bytes, 'base64'))
      const existing = db
        .select({ id: icons.id })
        .from(icons)
        .where(and(eq(icons.mimeType, row.mime_type), eq(icons.data, bytes)))
        .get()
      if (existing) {
        iconMap.set(row.id, existing.id)
        continue
      }
      const id = newIconId(epochMs(now))
      db.insert(icons).values({ id, mimeType: row.mime_type, data: bytes }).run()
      iconMap.set(row.id, id)
      report.icons++
    }

    for (const row of readRows(opts.dumpDir, 'feed_icons', mfFeedIcon)) {
      const feedId = feedMap.get(row.feed_id)
      const iconId = iconMap.get(row.icon_id)
      if (!feedId || !iconId) continue
      const linked = db
        .insert(feedIcons)
        .values({ feedId, iconId })
        .onConflictDoNothing()
        .returning({ feedId: feedIcons.feedId })
        .all()
      if (linked.length > 0) report.feedIcons++
    }

    // --- prefs side-DB: scope `user` | `feed:<int>` remapped to new UUIDs ---
    if (opts.prefsDbPath && existsSync(opts.prefsDbPath)) {
      // lazy: keeps `bun:sqlite` out of the module-eval graph (build-time
      // route analysis loads this bundle under a plain ESM loader)
      const { Database } = createRequire(import.meta.url)(
        'bun:sqlite',
      ) as typeof import('bun:sqlite')
      const prefsDb = new Database(opts.prefsDbPath, { readonly: true })
      try {
        const rows = prefsDb
          .query<{ user_id: number; scope: string; prefs: string }, []>(
            'SELECT user_id, scope, prefs FROM user_prefs',
          )
          .all()
        for (const row of rows) {
          const userId = userMap.get(row.user_id)
          if (!userId) {
            report.skipped.orphanPrefs++
            continue
          }
          let scope = row.scope
          if (scope.startsWith('feed:')) {
            const feedId = feedMap.get(Number(scope.slice('feed:'.length)))
            if (!feedId) {
              report.skipped.orphanPrefs++
              continue
            }
            scope = `feed:${feedId}`
          }
          const stored = db
            .insert(userPrefs)
            .values({ userId, scope, prefs: row.prefs })
            .onConflictDoNothing()
            .returning({ scope: userPrefs.scope })
            .all()
          if (stored.length > 0) report.prefs++
        }
      } finally {
        prefsDb.close()
      }
    }
  })
  run()
  // The search index is app-maintained (db/search-sync.ts): entries are bulk-
  // inserted here, so build the index once at the end instead of per row.
  rebuildEntrySearch(sqlite)
  return report
}

export type { MfEntry, MfFeed }
