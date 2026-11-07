import { describe, expect, test } from 'bun:test'

import { openDatabase } from '../src/server/db'
import { rebuildEntrySearch } from '../src/server/db/search-sync'
import {
  categories,
  entries,
  feedIcons,
  feeds,
  icons,
  userPrefs,
  users,
} from '../src/server/db/schema'
import { unsubscribeFeed } from '../src/server/query/mutations'
import {
  epochMs,
  newCategoryId,
  newEntryId,
  newFeedId,
  newIconId,
  newUserId,
} from '../src/shared/ids'
import { feedScope, userScope } from '../src/shared/prefs'

const NOW = epochMs(1_750_000_000_000)

function seed() {
  const handle = openDatabase(':memory:')
  const userId = newUserId(NOW)
  const categoryId = newCategoryId(NOW)
  const feedA = newFeedId(NOW)
  const feedB = newFeedId(NOW)
  handle.db
    .insert(users)
    .values({ id: userId, username: 'spiffy', passwordHash: 'argon2id$fake', createdAt: NOW })
    .run()
  handle.db
    .insert(categories)
    .values({ id: categoryId, userId, title: 'Tech', createdAt: NOW })
    .run()
  for (const [id, title] of [
    [feedA, 'Blog'],
    [feedB, 'Other'],
  ] as const) {
    handle.db
      .insert(feeds)
      .values({
        id,
        userId,
        categoryId,
        title,
        feedUrl: `https://example.com/${title}.xml`,
        createdAt: NOW,
      })
      .run()
  }
  for (const feedId of [feedA, feedB]) {
    for (const n of [1, 2]) {
      handle.db
        .insert(entries)
        .values({
          id: newEntryId(NOW),
          userId,
          feedId,
          hash: `${feedId}${n}${'a'.repeat(61)}`.slice(0, 64),
          title: `Post ${n}`,
          content: `<p>unique${n} content</p>`,
          publishedAt: epochMs(1_750_000_000_000 + n),
          createdAt: NOW,
          changedAt: NOW,
          tags: [],
        })
        .run()
    }
  }
  handle.db
    .insert(userPrefs)
    .values({ userId, scope: userScope(), prefs: JSON.stringify({}) })
    .run()
  handle.db
    .insert(userPrefs)
    .values({
      userId,
      scope: feedScope(feedA),
      prefs: JSON.stringify({ hiddenEntryKeywords: ['x'] }),
    })
    .run()
  handle.db
    .insert(userPrefs)
    .values({
      userId,
      scope: feedScope(feedB),
      prefs: JSON.stringify({ hiddenEntryKeywords: ['y'] }),
    })
    .run()
  // favicon rows are children of feeds too (FK, no cascade) — model them, or
  // the test passes where reality fails. The icon bytes are shared/deduped.
  const iconId = newIconId(NOW)
  handle.db
    .insert(icons)
    .values({ id: iconId, data: new Uint8Array([1, 2, 3]), mimeType: 'image/png' })
    .run()
  handle.db.insert(feedIcons).values({ feedId: feedA, iconId }).run()
  handle.db.insert(feedIcons).values({ feedId: feedB, iconId }).run()
  // the import builds the index in one pass; mirror that here
  rebuildEntrySearch(handle.sqlite)
  return { ...handle, userId, feedA, feedB }
}

/** Index hits for a term (the only meaningful fts read — count(*) reads the content passthrough). */
function hits(sqlite: ReturnType<typeof openDatabase>['sqlite'], term: string): number {
  return (
    sqlite.query(`SELECT count(*) AS n FROM entries_fts WHERE entries_fts MATCH ?`).get(term) as {
      n: number
    }
  ).n
}

function indexConsistent(sqlite: ReturnType<typeof openDatabase>['sqlite']): boolean {
  try {
    sqlite.run(`INSERT INTO entries_fts(entries_fts, rank) VALUES('integrity-check', 1)`)
    return true
  } catch {
    return false
  }
}

describe('unsubscribeFeed', () => {
  test('deletes entries before the feed (FK order) and keeps the search index in sync', () => {
    const s = seed()
    expect(hits(s.sqlite, 'unique1')).toBe(2) // both feeds' first entry
    expect(indexConsistent(s.sqlite)).toBe(true)

    const ok = unsubscribeFeed(s, { userId: s.userId, feedId: s.feedA })
    expect(ok).toBe(true)

    // feed + its entries + its prefs gone
    expect(
      (s.sqlite.query(`SELECT count(*) AS n FROM feeds WHERE id = ?`).get(s.feedA) as { n: number })
        .n,
    ).toBe(0)
    expect(
      (
        s.sqlite.query(`SELECT count(*) AS n FROM entries WHERE feed_id = ?`).get(s.feedA) as {
          n: number
        }
      ).n,
    ).toBe(0)
    expect(
      (
        s.sqlite
          .query(`SELECT count(*) AS n FROM user_prefs WHERE scope = ?`)
          .get(feedScope(s.feedA)) as { n: number }
      ).n,
    ).toBe(0)
    // the favicon link goes with the feed; shared icon bytes stay
    expect(
      (
        s.sqlite.query(`SELECT count(*) AS n FROM feed_icons WHERE feed_id = ?`).get(s.feedA) as {
          n: number
        }
      ).n,
    ).toBe(0)
    expect((s.sqlite.query(`SELECT count(*) AS n FROM icons`).get() as { n: number }).n).toBe(1)
    // no ghost hits: the removed feed's entries drop out of search entirely
    expect(hits(s.sqlite, 'unique1')).toBe(1)
    expect(hits(s.sqlite, 'unique2')).toBe(1)
    expect(indexConsistent(s.sqlite)).toBe(true)
    // the sibling feed is fully intact, including its prefs
    expect(
      (
        s.sqlite.query(`SELECT count(*) AS n FROM entries WHERE feed_id = ?`).get(s.feedB) as {
          n: number
        }
      ).n,
    ).toBe(2)
    expect(
      (
        s.sqlite
          .query(`SELECT count(*) AS n FROM user_prefs WHERE scope = ?`)
          .get(feedScope(s.feedB)) as { n: number }
      ).n,
    ).toBe(1)
  })

  test("returns false for unknown feeds and other users' feeds", () => {
    const s = seed()
    const otherUserId = newUserId(NOW)
    s.db
      .insert(users)
      .values({ id: otherUserId, username: 'else', passwordHash: 'argon2id$fake', createdAt: NOW })
      .run()
    expect(unsubscribeFeed(s, { userId: otherUserId, feedId: s.feedA })).toBe(false)
    expect(unsubscribeFeed(s, { userId: s.userId, feedId: newFeedId(NOW) })).toBe(false)
    expect(
      (
        s.sqlite.query(`SELECT count(*) AS n FROM entries WHERE feed_id = ?`).get(s.feedA) as {
          n: number
        }
      ).n,
    ).toBe(2)
    expect(
      (
        s.sqlite.query(`SELECT count(*) AS n FROM feed_icons WHERE feed_id = ?`).get(s.feedA) as {
          n: number
        }
      ).n,
    ).toBe(1)
  })
})
