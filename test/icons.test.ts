import { expect, test } from 'bun:test'

import { openDatabase } from '../src/server/db'
import { feedIcons, icons } from '../src/server/db/schema'
import { ensureFeedIcon } from '../src/server/fetch/icons'
import { ingestFeedOutcome, fetchAndIngest } from '../src/server/fetch/fetch-feed'
import { parseFeedBody } from '../src/server/fetch/parse'
import { epochMs, newCategoryId, newFeedId, newUserId } from '../src/shared/ids'

const NOW = 1_750_000_000_000
const opts = { now: NOW, jitterSeconds: () => 0 }

function setup() {
  const handle = openDatabase(':memory:')
  const userId = newUserId(epochMs(NOW))
  handle.sqlite.run(
    'INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)',
    [userId, 'spiffy', 'h', NOW],
  )
  handle.sqlite.run('INSERT INTO categories (id, user_id, title, created_at) VALUES (?, ?, ?, ?)', [
    newCategoryId(epochMs(NOW)),
    userId,
    'Tech',
    NOW,
  ])
  return { handle, userId }
}

test('parse extracts and resolves the feed-declared icon', () => {
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>B</title><link>https://a.example/</link>
    <image><url>/logo.png</url><title>B</title></image>
    <item><title>One</title><guid>g</guid></item></channel></rss>`
  const feed = parseFeedBody(rss, 'https://a.example/feed', opts)
  expect(feed.iconUrl).toBe('https://a.example/logo.png')

  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>T</title>
    <logo>https://cdn.example/icon.svg</logo>
    <entry><id>x</id></entry></feed>`
  expect(parseFeedBody(atom, 'https://a.example/feed', opts).iconUrl).toBe(
    'https://cdn.example/icon.svg',
  )

  const plain = `<?xml version="1.0"?><rss version="2.0"><channel><title>B</title><link>https://a.example/</link></channel></rss>`
  expect(parseFeedBody(plain, 'https://a.example/feed', opts).iconUrl).toBeNull()
})

test('ensureFeedIcon fetches bytes once and then stands down', async () => {
  let hits = 0
  const server = Bun.serve({
    port: 0,
    fetch() {
      hits++
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { 'content-type': 'image/png' },
      })
    },
  })
  const { handle } = setup()
  const feedId = newFeedId(epochMs(NOW))
  handle.sqlite.run(
    'INSERT INTO feeds (id, user_id, category_id, title, feed_url, created_at) VALUES (?, (SELECT id FROM users), (SELECT id FROM categories), ?, ?, ?)',
    [feedId, 'Blog', 'https://a.example/feed', NOW],
  )
  const url = `http://localhost:${server.port}/favicon.png`

  expect(await ensureFeedIcon({ handle, feedId, candidates: [url], now: NOW })).toBe(true)
  expect(hits).toBe(1)
  expect(handle.db.select().from(feedIcons).all()).toHaveLength(1)
  const icon = handle.db.select().from(icons).all()[0]!
  expect(icon.mimeType).toBe('image/png')
  expect(Array.from(icon.data)).toEqual([137, 80, 78, 71])

  // second call: already has an icon — no refetch
  expect(await ensureFeedIcon({ handle, feedId, candidates: [url], now: NOW })).toBe(true)
  expect(hits).toBe(1)
  server.stop(true)
})

test('fetchAndIngest wires the whole cycle including the favicon fallback', async () => {
  let faviconHits = 0
  let base = ''
  const server = Bun.serve({
    port: 0,
    fetch(req): Response {
      const path = new URL(req.url).pathname
      if (path === '/feed.xml') {
        return new Response(
          `<?xml version="1.0"?><rss version="2.0"><channel><title>B</title><link>${base}/</link>
            <item><title>One</title><guid>g1</guid></item></channel></rss>`,
          { headers: { 'content-type': 'text/xml' } },
        )
      }
      faviconHits++
      return new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'image/png' } })
    },
  })
  base = `http://localhost:${server.port}`
  const { handle } = setup()
  const feedId = newFeedId(epochMs(NOW))
  handle.sqlite.run(
    'INSERT INTO feeds (id, user_id, category_id, title, feed_url, created_at) VALUES (?, (SELECT id FROM users), (SELECT id FROM categories), ?, ?, ?)',
    [feedId, 'Blog', `http://localhost:${server.port}/feed.xml`, NOW],
  )

  const result = await fetchAndIngest({ handle, feedId, now: NOW })
  expect(result.kind).toBe('ok')
  if (result.kind === 'ok') expect(result.inserted).toBe(1)
  expect(faviconHits).toBe(1) // site favicon.ico fallback resolved from the feed's link
  expect(handle.db.select().from(feedIcons).all()).toHaveLength(1)
  server.stop(true)
})
