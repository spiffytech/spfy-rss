/**
 * Seeds a disposable `test` account from the real account's data — the
 * on-demand replacement for the old live test account (deleted at cutover:
 * a passwordless account on a public login form is attack surface).
 *
 *   bun run scripts/seed-test-user.ts [--feeds N] [--entries N] [--from username]
 *
 * Copies the source user's most recently active feeds (default 3) with their
 * latest entries (default 50 each) into a fresh `test` user. The account ships
 * with NO password (login is impossible until one is set):
 *
 *   echo -n 'pw' | bun run scripts/set-password.ts test
 *
 * Delete when done: `bun run scripts/seed-test-user.ts --delete`
 */
import { join } from 'node:path'

import { eq, sql } from 'drizzle-orm'

import { openDatabase } from '../src/server/db'
import { categories, entries, feedIcons, feeds, users, userPrefs } from '../src/server/db/schema'
import { repoRoot } from '../src/server/repo-root'
import {
  epochMs,
  newCategoryId,
  newEntryId,
  newFeedId,
  newUserId,
  type FeedId,
} from '../src/shared/ids'

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

const handle = openDatabase(process.env.READER_DB_PATH ?? join(repoRoot, 'data', 'reader.sqlite'))
const { db } = handle

if (process.argv.includes('--delete')) {
  const test = db.select().from(users).where(eq(users.username, 'test')).get()
  if (!test) {
    console.log('no test user — nothing to do')
    process.exit(0)
  }
  const testFeeds = db
    .select({ id: feeds.id })
    .from(feeds)
    .where(eq(feeds.userId, test.id))
    .all()
    .map((f) => f.id)
  const tx = handle.sqlite.transaction(() => {
    for (const feedId of testFeeds) {
      db.delete(feedIcons)
        .where(eq(feedIcons.feedId, feedId as FeedId))
        .run()
      db.delete(entries)
        .where(eq(entries.feedId, feedId as FeedId))
        .run()
      db.delete(feeds)
        .where(eq(feeds.id, feedId as FeedId))
        .run()
    }
    db.delete(userPrefs).where(eq(userPrefs.userId, test.id)).run()
    db.delete(categories).where(eq(categories.userId, test.id)).run()
    db.delete(users).where(eq(users.id, test.id)).run()
    handle.sqlite.run(`INSERT INTO entries_fts(entries_fts) VALUES('rebuild')`)
  })
  tx()
  console.log(`deleted test user (${testFeeds.length} feeds)`)
  process.exit(0)
}

const from = arg('from', 'spiffytech')
const feedCount = Number(arg('feeds', '3'))
const entryCount = Number(arg('entries', '50'))
const now = epochMs(Date.now())

const source = db.select().from(users).where(eq(users.username, from)).get()
if (!source) {
  console.error(`no source user '${from}'`)
  process.exit(1)
}
if (db.select().from(users).where(eq(users.username, 'test')).get()) {
  console.error(
    'test user already exists — delete it first: bun run scripts/seed-test-user.ts --delete',
  )
  process.exit(2)
}

const tx = handle.sqlite.transaction(() => {
  const testId = newUserId(now)
  db.insert(users).values({ id: testId, username: 'test', passwordHash: '', createdAt: now }).run()

  // one category per source category title (typically "All")
  const catByTitle = new Map<string, ReturnType<typeof newCategoryId>>()
  for (const cat of db.select().from(categories).where(eq(categories.userId, source.id)).all()) {
    const id = newCategoryId(now)
    db.insert(categories).values({ id, userId: testId, title: cat.title, createdAt: now }).run()
    catByTitle.set(cat.title, id)
  }

  // most recently active feeds first, capped at --feeds
  const sourceFeeds = db
    .select()
    .from(feeds)
    .where(eq(feeds.userId, source.id))
    .orderBy(sql`checked_at DESC NULLS LAST`)
    .limit(feedCount)
    .all()

  for (const feed of sourceFeeds) {
    const feedId = newFeedId(now)
    db.insert(feeds)
      .values({
        id: feedId,
        userId: testId,
        categoryId:
          catByTitle.get(feed.title) ??
          ([...catByTitle.values()][0] as ReturnType<typeof newCategoryId>),
        title: feed.title,
        feedUrl: feed.feedUrl,
        siteUrl: feed.siteUrl,
        etagHeader: null,
        lastModifiedHeader: null,
        checkedAt: null,
        parsingErrorCount: 0,
        createdAt: now,
      })
      .run()

    const recent = db
      .select()
      .from(entries)
      .where(eq(entries.feedId, feed.id))
      .orderBy(sql`published_at DESC`)
      .limit(entryCount)
      .all()
    for (const entry of recent) {
      db.insert(entries)
        .values({
          id: newEntryId(now),
          userId: testId,
          feedId,
          hash: entry.hash,
          title: entry.title,
          url: entry.url,
          author: entry.author,
          content: entry.content,
          publishedAt: entry.publishedAt,
          createdAt: now,
          changedAt: now,
          status: 'unread',
          starred: false,
          readingTime: entry.readingTime,
          tags: entry.tags,
        })
        .onConflictDoNothing()
        .run()
    }

    const icon = db.select().from(feedIcons).where(eq(feedIcons.feedId, feed.id)).get()
    if (icon)
      db.insert(feedIcons).values({ feedId, iconId: icon.iconId }).onConflictDoNothing().run()
    console.log(`  + ${feed.title} (${recent.length} entries)`)
  }

  handle.sqlite.run(`INSERT INTO entries_fts(entries_fts) VALUES('rebuild')`)
})
tx()

console.log('test user seeded. Password is unset — login is impossible until:')
console.log("  echo -n 'pw' | bun run scripts/set-password.ts test")
