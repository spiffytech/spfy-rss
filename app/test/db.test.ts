import { describe, expect, test } from 'bun:test'
import type { SQLQueryBindings } from 'bun:sqlite'

import { openDatabase } from '../src/server/db'
import { categories, entries, feedIcons, feeds, icons, userPrefs, users } from '../src/server/db/schema'
import { epochMs, newCategoryId, newEntryId, newFeedId, newIconId, newUserId } from '../src/shared/ids'
import type { FeedId, UserId } from '../src/shared/ids'

const NOW = epochMs(1_750_000_000_000)

function seed() {
  const handle = openDatabase(':memory:')
  const userId = newUserId(NOW)
  const categoryId = newCategoryId(NOW)
  const feedId = newFeedId(NOW)
  handle.db.insert(users).values({ id: userId, username: 'spiffy', passwordHash: 'argon2id$fake', createdAt: NOW }).run()
  handle.db.insert(categories).values({ id: categoryId, userId, title: 'Tech', createdAt: NOW }).run()
  handle.db
    .insert(feeds)
    .values({ id: feedId, userId, categoryId, title: 'Blog', feedUrl: 'https://example.com/feed.xml', createdAt: NOW })
    .run()
  return { ...handle, userId, categoryId, feedId }
}

function entryValues(feedId: FeedId, userId: UserId) {
  return {
    id: newEntryId(NOW),
    userId,
    feedId,
    hash: 'a'.repeat(64),
    title: 'Hello',
    content: '<p>alpha content</p>',
    publishedAt: NOW,
    createdAt: NOW,
    changedAt: NOW,
    tags: ['tech', 'rss'],
  }
}

describe('schema + migrations', () => {
  test('migrations create every table', () => {
    const { sqlite } = openDatabase(':memory:')
    const names = sqlite
      .query<{ name: string }, SQLQueryBindings[]>("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
      .all()
      .map((r) => r.name)
    for (const table of ['users', 'categories', 'feeds', 'entries', 'icons', 'feed_icons', 'user_prefs', 'entries_fts']) {
      expect(names).toContain(table)
    }
  })

  test('dead fields are gone and fetch errors have a place to live', () => {
    const { sqlite } = openDatabase(':memory:')
    const cols = (table: string) =>
      sqlite
        .query<{ name: string }, SQLQueryBindings[]>(`PRAGMA table_info(${table})`)
        .all()
        .map((r) => r.name)
    expect(cols('users')).not.toContain('is_admin')
    expect(cols('feeds')).not.toContain('disabled')
    expect(cols('feeds')).toEqual(expect.arrayContaining(['last_error', 'last_error_at']))
    expect(cols('entries')).not.toContain('comments_url')
    expect(cols('entries')).not.toContain('language')
  })

  test('times round-trip as plain epoch-ms numbers, tags as string[]', () => {
    const { db, userId, feedId } = seed()
    db.insert(entries).values(entryValues(feedId, userId)).run()
    const row = db.select().from(entries).all()[0]!
    expect(row.publishedAt).toBe(epochMs(1_750_000_000_000))
    expect(typeof row.publishedAt).toBe('number')
    expect(row.tags).toEqual(['tech', 'rss'])
  })

  test('icon bytes round-trip', () => {
    const { db, sqlite, feedId } = seed()
    const iconId = newIconId(NOW)
    const bytes = new Uint8Array([1, 2, 3, 250])
    db.insert(icons).values({ id: iconId, mimeType: 'image/png', data: bytes }).run()
    db.insert(feedIcons).values({ feedId, iconId }).run()
    const row = sqlite.query<{ data: Uint8Array }, SQLQueryBindings[]>('SELECT data FROM icons').get()!
    expect(row.data instanceof Uint8Array).toBe(true)
    expect(Array.from(row.data)).toEqual([1, 2, 3, 250])
  })

  test('UNIQUE(feed_id, hash) is the resurrection guard: a removed entry cannot be re-inserted', () => {
    const { db, sqlite, userId, feedId } = seed()
    db.insert(entries).values(entryValues(feedId, userId)).run()
    sqlite.run("UPDATE entries SET status = 'removed'")
    expect(() => db.insert(entries).values(entryValues(feedId, userId)).run()).toThrow()
    // the soft-deleted row is still there, still matching
    const row = sqlite.query<{ status: string }, SQLQueryBindings[]>('SELECT status FROM entries').get()!
    expect(row.status).toBe('removed')
  })

  test('foreign keys are enforced', () => {
    const { db, userId } = seed()
    expect(() => db.insert(entries).values(entryValues(newFeedId(NOW), userId)).run()).toThrow()
  })

  test('user_prefs keeps its baseline shape and composite key', () => {
    const { db, sqlite, userId } = seed()
    db.insert(userPrefs).values({ userId, scope: 'user', prefs: '{"hideEmptyFeeds":true}' }).run()
    db.insert(userPrefs).values({ userId, scope: 'feed:1', prefs: '{"viewMode":"list"}' }).run()
    expect(() => db.insert(userPrefs).values({ userId, scope: 'user' }).run()).toThrow()
    const rows = sqlite
      .query<{ scope: string }, SQLQueryBindings[]>('SELECT scope FROM user_prefs ORDER BY scope')
      .all()
    expect(rows.map((r) => r.scope)).toEqual(['feed:1', 'user'])
    const inserted = sqlite.query<{ prefs: string }, SQLQueryBindings[]>("SELECT prefs FROM user_prefs WHERE scope = 'feed:1'").get()!
    expect(JSON.parse(inserted.prefs)).toEqual({ viewMode: 'list' })
  })
})
