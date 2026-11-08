import { expect, test } from 'bun:test'

import { openDatabase, type ReaderHandle } from '../src/server/db'
import { entries, feeds } from '../src/server/db/schema'
import { ingestFeedOutcome } from '../src/server/fetch/fetch-feed'
import type { FetchOutcome } from '../src/server/fetch/transport'
import { epochMs, newCategoryId, newFeedId, newUserId, type FeedId } from '../src/shared/ids'

const NOW = 1_750_000_000_000

const rssBody = (items: string) => `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel><title>Blog</title><link>https://a.example/</link>${items}</channel>
</rss>`

const item = (id: string, title: string, body: string) =>
  `<item><title>${title}</title><link>https://a.example/${id}</link><guid isPermaLink="false">${id}</guid><description><![CDATA[${body}]]></description></item>`

function ok(body: string, over: Partial<Extract<FetchOutcome, { kind: 'ok' }>> = {}): FetchOutcome {
  return {
    kind: 'ok',
    body,
    etag: 'W/"v1"',
    lastModified: null,
    finalUrl: 'https://a.example/feed',
    freshnessMs: null,
    permanentlyMoved: false,
    fetchedAt: epochMs(NOW),
    ...over,
  }
}

function setup(): { handle: ReaderHandle; feedId: FeedId } {
  const handle = openDatabase(':memory:')
  const userId = newUserId(epochMs(NOW))
  handle.sqlite.run(
    'INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)',
    [userId, 'spiffy', 'argon2id$fake', NOW],
  )
  handle.sqlite.run('INSERT INTO categories (id, user_id, title, created_at) VALUES (?, ?, ?, ?)', [
    newCategoryId(epochMs(NOW)),
    userId,
    'Tech',
    NOW,
  ])
  const feedId = newFeedId(epochMs(NOW))
  handle.sqlite.run(
    'INSERT INTO feeds (id, user_id, category_id, title, feed_url, created_at) VALUES (?, ?, (SELECT id FROM categories), ?, ?, ?)',
    [feedId, userId, 'Blog', 'https://a.example/feed', NOW],
  )
  return { handle, feedId }
}

test('ingest inserts new entries as unread and indexes them for search', () => {
  const { handle, feedId } = setup()
  const result = ingestFeedOutcome({
    handle,
    feedId,
    outcome: ok(rssBody(item('g1', 'One', '<p>alpha body</p>') + item('g2', 'Two', '<p>beta</p>'))),
    now: NOW,
  })
  expect(result).toEqual({
    kind: 'ok',
    inserted: 2,
    updated: 0,
    moved: false,
    iconUrl: null,
    siteUrl: 'https://a.example/',
    freshnessMs: null,
  })
  const rows = handle.db.select().from(entries).all()
  expect(rows.map((r) => r.status)).toEqual(['unread', 'unread'])
  expect(rows.find((r) => r.title === 'One')!.readingTime).toBe(1)
  const hits = handle.sqlite
    .query<{ rowid: number }, []>("SELECT rowid FROM entries_fts WHERE entries_fts MATCH 'alpha'")
    .all()
  expect(hits).toHaveLength(1)
})

test('refetch is idempotent and quiet', () => {
  const { handle, feedId } = setup()
  const body = rssBody(item('g1', 'One', '<p>alpha</p>'))
  ingestFeedOutcome({ handle, feedId, outcome: ok(body), now: NOW })
  const second = ingestFeedOutcome({ handle, feedId, outcome: ok(body), now: NOW + 5_000 })
  expect(second).toEqual({
    kind: 'ok',
    inserted: 0,
    updated: 0,
    moved: false,
    iconUrl: null,
    siteUrl: 'https://a.example/',
    freshnessMs: null,
  })
  expect(handle.db.select().from(entries).all()).toHaveLength(1)
})

test('content changes update in place (changed_at moves, no duplicate)', () => {
  const { handle, feedId } = setup()
  ingestFeedOutcome({
    handle,
    feedId,
    outcome: ok(rssBody(item('g1', 'One', '<p>alpha</p>'))),
    now: NOW,
  })
  const result = ingestFeedOutcome({
    handle,
    feedId,
    outcome: ok(rssBody(item('g1', 'One', '<p>alpha rewritten</p>'))),
    now: NOW + 5_000,
  })
  expect(result).toEqual({
    kind: 'ok',
    inserted: 0,
    updated: 1,
    moved: false,
    iconUrl: null,
    siteUrl: 'https://a.example/',
    freshnessMs: null,
  })
  const row = handle.db.select().from(entries).all()[0]!
  expect(row.changedAt).toBe(epochMs(NOW + 5_000))
  expect(row.createdAt).toBe(epochMs(NOW)) // first-seen time preserved
  expect(handle.db.select().from(entries).all()).toHaveLength(1)
  // search index followed the rewrite
  const hits = handle.sqlite
    .query<{ rowid: number }, []>(
      "SELECT rowid FROM entries_fts WHERE entries_fts MATCH 'rewritten'",
    )
    .all()
  expect(hits).toHaveLength(1)
})

test('removed entries never resurrect', () => {
  const { handle, feedId } = setup()
  const body = rssBody(item('g1', 'One', '<p>alpha</p>'))
  ingestFeedOutcome({ handle, feedId, outcome: ok(body), now: NOW })
  handle.sqlite.run("UPDATE entries SET status = 'removed'")
  const result = ingestFeedOutcome({ handle, feedId, outcome: ok(body), now: NOW + 5_000 })
  expect(result).toEqual({
    kind: 'ok',
    inserted: 0,
    updated: 0,
    moved: false,
    iconUrl: null,
    siteUrl: 'https://a.example/',
    freshnessMs: null,
  })
  expect(handle.db.select().from(entries).all()[0]!.status).toBe('removed')
})

test('errors bump parsing_error_count; a 304 or a success resets it', () => {
  const { handle, feedId } = setup()
  ingestFeedOutcome({
    handle,
    feedId,
    outcome: { kind: 'error', message: 'HTTP 500', httpStatus: 500, fetchedAt: epochMs(NOW) },
  })
  let feed = handle.db.select().from(feeds).all()[0]!
  expect(feed.parsingErrorCount).toBe(1)

  ingestFeedOutcome({
    handle,
    feedId,
    outcome: { kind: 'not-modified', fetchedAt: epochMs(NOW + 1000), freshnessMs: null },
  })
  feed = handle.db.select().from(feeds).all()[0]!
  expect(feed.checkedAt).toBe(epochMs(NOW + 1000))
  // A 304 proves the resource is healthy — the streak ends with it.
  expect(feed.parsingErrorCount).toBe(0)

  ingestFeedOutcome({
    handle,
    feedId,
    outcome: ok(rssBody(item('g1', 'One', '<p>a</p>'))),
    now: NOW + 2000,
  })
  feed = handle.db.select().from(feeds).all()[0]!
  expect(feed.parsingErrorCount).toBe(0)
  expect(feed.etagHeader).toBe('W/"v1"')
})

test('a permanent move rewrites the stored feed_url', () => {
  const { handle, feedId } = setup()
  ingestFeedOutcome({
    handle,
    feedId,
    outcome: ok(rssBody(item('g1', 'One', '<p>a</p>')), {
      permanentlyMoved: true,
      finalUrl: 'https://b.example/feed',
    }),
    now: NOW,
  })
  expect(handle.db.select().from(feeds).all()[0]!.feedUrl).toBe('https://b.example/feed')
})
