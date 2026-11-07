import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { openDatabase, type ReaderHandle } from '../src/server/db'
import { categories, entries, feeds, users } from '../src/server/db/schema'
import { discoverAlternateFeeds } from '../src/server/fetch/discover'
import { editFeed, normalizeFeedUrl, subscribe } from '../src/server/fetch/subscribe'
import { epochMs, newUserId, type UserId } from '../src/shared/ids'

let server: ReturnType<typeof Bun.serve>
let base: string

const rss = (title: string, item: string, extra = '') => `<?xml version="1.0"?>
<rss version="2.0"><channel><title>${title}</title><link>${base}/</link><description>d</description>${extra}
<item><title>${item}</title><guid>${item}</guid><link>${base}/${item}</link>
<pubDate>Wed, 01 Oct 2025 12:00:00 GMT</pubDate></item></channel></rss>`

beforeEach(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      switch (url.pathname) {
        case '/feed.xml':
          return new Response(rss('Test Feed', 'one', ''), {
            headers: { 'content-type': 'application/rss+xml', etag: 'W/"feed"' },
          })
        case '/other.xml':
          return new Response(rss('Other Feed', 'two'), {
            headers: { 'content-type': 'application/rss+xml' },
          })
        case '/site':
          return new Response(
            `<!doctype html><html><head>
              <link rel="stylesheet" href="/app.css">
              <link rel="alternate" type="application/rss+xml" href="/feed.xml">
            </head><body>site</body></html>`,
            { headers: { 'content-type': 'text/html' } },
          )
        case '/bad':
          return new Response('<html><head><title>No feed</title></head></html>', {
            headers: { 'content-type': 'text/html' },
          })
        case '/moved':
          return new Response(null, { status: 301, headers: { location: `${base}/feed.xml` } })
        default:
          return new Response('not found', { status: 404 })
      }
    },
  })
  base = `http://localhost:${server.port}`
})

afterEach(() => {
  server.stop(true)
})

function setup(): { handle: ReaderHandle; userId: UserId } {
  const handle = openDatabase(':memory:')
  const userId = newUserId(epochMs(1_750_000_000_000))
  handle.db
    .insert(users)
    .values({
      id: userId,
      username: 'spiffy',
      passwordHash: 'h',
      createdAt: epochMs(1_750_000_000_000),
    })
    .run()
  return { handle, userId }
}

describe('URL and discovery helpers', () => {
  test('normalizeFeedUrl adds https to a bare host and rejects other schemes', () => {
    expect(normalizeFeedUrl('example.com/feed.xml')).toBe('https://example.com/feed.xml')
    expect(normalizeFeedUrl('http://example.com/feed.xml')).toBe('http://example.com/feed.xml')
    expect(normalizeFeedUrl('ftp://example.com/feed.xml')).toBeNull()
    expect(normalizeFeedUrl('   ')).toBeNull()
  })

  test('discoverAlternateFeeds resolves relative links and ignores non-feed alternates', () => {
    const html = `
      <link rel="alternate" type="application/atom+xml" href="/atom.xml?x=1&amp;y=2">
      <link rel="alternate" type="text/html" href="/print">
      <link rel="alternate" type="application/rss+xml" href="https://cdn.example/rss">
      <link rel="alternate" type="application/rss+xml" href="/atom.xml?x=1&amp;y=2">`
    expect(discoverAlternateFeeds(html, 'https://site.example/page')).toEqual([
      'https://site.example/atom.xml?x=1&y=2',
      'https://cdn.example/rss',
    ])
  })
})

describe('subscribe', () => {
  test('stores an uncategorized feed and ingests it immediately', async () => {
    const { handle, userId } = setup()
    const result = await subscribe(handle, { userId, url: `${base}/feed.xml` })
    if (!result.ok) throw new Error(result.reason)

    const row = handle.db.select().from(feeds).get()!
    expect(row.id).toBe(result.feedId)
    expect(row.categoryId).toBeNull()
    expect(row.title).toBe('Test Feed')
    expect(row.checkedAt).not.toBeNull()
    expect(handle.db.select().from(entries).where(eq(entries.feedId, row.id)).all()).toHaveLength(1)
  })

  test('discovers a feed from an HTML site URL', async () => {
    const { handle, userId } = setup()
    const result = await subscribe(handle, { userId, url: `${base}/site` })
    if (!result.ok) throw new Error(result.reason)
    expect(handle.db.select().from(feeds).get()!.feedUrl).toBe(`${base}/feed.xml`)
  })

  test('follows a permanent redirect and stores the final URL', async () => {
    const { handle, userId } = setup()
    const result = await subscribe(handle, { userId, url: `${base}/moved` })
    if (!result.ok) throw new Error(result.reason)
    expect(handle.db.select().from(feeds).get()!.feedUrl).toBe(`${base}/feed.xml`)
  })

  test('rejects a duplicate feed URL and names the existing feed', async () => {
    const { handle, userId } = setup()
    const first = await subscribe(handle, { userId, url: `${base}/feed.xml` })
    if (!first.ok) throw new Error(first.reason)
    expect(await subscribe(handle, { userId, url: `${base}/feed.xml` })).toEqual({
      ok: false,
      reason: 'duplicate',
      feedId: first.feedId,
    })
  })

  test('recognizes a duplicate after a redirect stores a different URL', async () => {
    const { handle, userId } = setup()
    const first = await subscribe(handle, { userId, url: `${base}/moved` })
    if (!first.ok) throw new Error(first.reason)
    expect(await subscribe(handle, { userId, url: `${base}/feed.xml` })).toEqual({
      ok: false,
      reason: 'duplicate',
      feedId: first.feedId,
    })
    expect(handle.db.select().from(feeds).all()).toHaveLength(1)
  })

  test('creates and reuses a folder from newCategoryTitle', async () => {
    const { handle, userId } = setup()
    const first = await subscribe(handle, {
      userId,
      url: `${base}/feed.xml`,
      newCategoryTitle: 'Tech',
    })
    if (!first.ok) throw new Error(first.reason)
    const folder = handle.db.select().from(categories).get()!
    expect(folder.title).toBe('Tech')
    expect(handle.db.select().from(feeds).get()!.categoryId).toBe(folder.id)

    const second = await subscribe(handle, {
      userId,
      url: `${base}/other.xml`,
      newCategoryTitle: 'Tech',
    })
    if (!second.ok) throw new Error(second.reason)
    expect(handle.db.select().from(categories).all()).toHaveLength(1)
  })

  test('leaves no feed behind when the URL is not a feed', async () => {
    const { handle, userId } = setup()
    const result = await subscribe(handle, { userId, url: `${base}/bad` })
    expect(result).toEqual({ ok: false, reason: 'parse', detail: 'not a feed' })
    expect(handle.db.select().from(feeds).all()).toHaveLength(0)
  })
})

describe('editFeed', () => {
  test('edits title and folder without touching the feed URL', async () => {
    const { handle, userId } = setup()
    const added = await subscribe(handle, { userId, url: `${base}/feed.xml` })
    if (!added.ok) throw new Error(added.reason)

    const result = await editFeed(handle, {
      userId,
      feedId: added.feedId,
      title: 'Renamed',
      feedUrl: `${base}/feed.xml`,
      categoryId: null,
    })
    expect(result).toEqual({ ok: true, feedId: added.feedId, urlChanged: false })

    const row = handle.db.select().from(feeds).get()!
    expect(row.title).toBe('Renamed')
    expect(row.feedUrl).toBe(`${base}/feed.xml`)
    expect(row.etagHeader).toBe('W/"feed"')
  })

  test('a URL change resets fetch continuity, keeps old entries and ingests the new feed', async () => {
    const { handle, userId } = setup()
    const added = await subscribe(handle, { userId, url: `${base}/feed.xml` })
    if (!added.ok) throw new Error(added.reason)

    const result = await editFeed(handle, {
      userId,
      feedId: added.feedId,
      title: 'Edited',
      feedUrl: `${base}/other.xml`,
    })
    expect(result).toEqual({ ok: true, feedId: added.feedId, urlChanged: true })

    const row = handle.db.select().from(feeds).get()!
    expect(row.feedUrl).toBe(`${base}/other.xml`)
    expect(row.title).toBe('Edited')
    expect(row.etagHeader).toBeNull()

    const titles = handle.db
      .select({ title: entries.title })
      .from(entries)
      .where(eq(entries.feedId, added.feedId))
      .all()
      .map((entry) => entry.title)
      .sort()
    expect(titles).toEqual(['one', 'two'])
  })

  test('refuses a URL owned by another feed', async () => {
    const { handle, userId } = setup()
    const first = await subscribe(handle, { userId, url: `${base}/feed.xml` })
    const second = await subscribe(handle, { userId, url: `${base}/other.xml` })
    if (!first.ok || !second.ok) throw new Error('setup failed')

    expect(
      await editFeed(handle, { userId, feedId: first.feedId, feedUrl: `${base}/other.xml` }),
    ).toEqual({ ok: false, reason: 'duplicate' })
    expect(handle.db.select().from(feeds).all()).toHaveLength(2)
  })

  test('does not create a folder when the new URL fails to resolve', async () => {
    const { handle, userId } = setup()
    const added = await subscribe(handle, { userId, url: `${base}/feed.xml` })
    if (!added.ok) throw new Error(added.reason)

    const result = await editFeed(handle, {
      userId,
      feedId: added.feedId,
      feedUrl: `${base}/bad`,
      newCategoryTitle: 'Should Not Exist',
    })
    expect(result).toEqual({ ok: false, reason: 'parse', detail: 'not a feed' })
    expect(handle.db.select().from(categories).all()).toHaveLength(0)
    expect(handle.db.select().from(feeds).get()!.feedUrl).toBe(`${base}/feed.xml`)
  })

  test('returns not_found for a feed the user does not own', async () => {
    const { handle, userId } = setup()
    const added = await subscribe(handle, { userId, url: `${base}/feed.xml` })
    if (!added.ok) throw new Error(added.reason)

    const other = newUserId(epochMs(1_750_000_000_001))
    handle.db
      .insert(users)
      .values({
        id: other,
        username: 'other',
        passwordHash: 'h',
        createdAt: epochMs(1_750_000_000_001),
      })
      .run()
    expect(await editFeed(handle, { userId: other, feedId: added.feedId, title: 'x' })).toEqual({
      ok: false,
      reason: 'not_found',
    })
  })
})
