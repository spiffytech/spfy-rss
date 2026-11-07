import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'

import { openDatabase, type ReaderHandle } from '../src/server/db'
import { feeds } from '../src/server/db/schema'
import {
  callbackUrl,
  discoverHub,
  ensureSubscribed,
  LEASE_SECONDS,
  newCallbackToken,
  renewDue,
  verifySignature,
} from '../src/server/websub'
import { epochMs, newCategoryId, newFeedId, newUserId, type FeedId } from '../src/shared/ids'

const NOW = 1_750_000_000_000
const DAY = 86_400_000

const atomWithHub = (hub = 'https://hub.example/', self = 'https://a.example/feed') =>
  `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Blog</title>
  <link rel="self" href="${self}"/>
  <link rel="hub" href="${hub}"/>
</feed>`

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

const realFetch = globalThis.fetch
let fetchCalls: { url: string; body: string }[] = []
let hubAnswers = true

beforeEach(() => {
  fetchCalls = []
  hubAnswers = true
  process.env.READER_PUBLIC_URL = 'https://reader.example'
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? String(init.body) : ''
    fetchCalls.push({ url, body })
    return new Response(null, { status: hubAnswers ? 202 : 500 })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.READER_PUBLIC_URL
})

describe('discoverHub', () => {
  test('finds rel="hub" and rel="self" in an Atom head', () => {
    const { hub, self } = discoverHub(atomWithHub())
    expect(hub).toBe('https://hub.example/')
    expect(self).toBe('https://a.example/feed')
  })

  test('rel may carry several tokens', () => {
    const body = `<feed><link rel="self hub" href="https://hub.example/"/></feed>`
    expect(discoverHub(body).hub).toBe('https://hub.example/')
    expect(discoverHub(body).self).toBe('https://hub.example/')
  })

  test('a feed with no hub reports null and does not invent one', () => {
    const body = `<feed><link rel="self" href="https://a.example/feed"/><link rel="alternate" href="https://a.example/"/></feed>`
    expect(discoverHub(body)).toEqual({ hub: null, self: 'https://a.example/feed' })
  })

  test('ignores a link with no href and survives malformed markup', () => {
    expect(discoverHub(`<feed><link rel="hub"/></feed>`).hub).toBeNull()
    expect(discoverHub(`not xml at all <link rel="hub" href="https://h/"> trailing`).hub).toBe(
      'https://h/',
    )
  })
})

describe('verifySignature', () => {
  test('accepts a correct sha1 HMAC', () => {
    const body = 'payload'
    const sig = `sha1=${createHmac('sha1', 'secret').update(body).digest('hex')}`
    expect(verifySignature('secret', body, sig)).toBe(true)
  })

  test('rejects a signature made with another secret', () => {
    const body = 'payload'
    const sig = `sha1=${createHmac('sha1', 'other').update(body).digest('hex')}`
    expect(verifySignature('secret', body, sig)).toBe(false)
  })

  test('absent header is accepted: the unguessable token is the real gate', () => {
    expect(verifySignature('secret', 'payload', null)).toBe(true)
  })

  test('malformed or wrong-algorithm headers are rejected', () => {
    expect(verifySignature('secret', 'payload', 'garbage')).toBe(false)
    expect(verifySignature('secret', 'payload', 'sha256=abc')).toBe(false)
    expect(verifySignature('secret', 'payload', 'sha1=zz')).toBe(false)
    expect(
      verifySignature('', 'payload', `sha1=${createHmac('sha1', 'x').update('p').digest('hex')}`),
    ).toBe(false)
  })
})

describe('ensureSubscribed', () => {
  test('does nothing at all when the feed advertises no hub', async () => {
    const { handle, feedId } = setup()
    await ensureSubscribed(
      handle,
      feedId,
      'https://a.example/feed',
      `<feed><link rel="self" href="https://a.example/feed"/></feed>`,
      NOW,
    )
    expect(fetchCalls).toHaveLength(0)
    const row = handle.db.select().from(feeds).get()
    expect(row!.websubHub).toBeNull()
    expect(row!.websubLeaseUntil).toBeNull()
  })

  test('subscribes and records hub, token and lease', async () => {
    const { handle, feedId } = setup()
    await ensureSubscribed(handle, feedId, 'https://a.example/feed', atomWithHub(), NOW)
    expect(fetchCalls).toHaveLength(1)
    const sent = new URLSearchParams(fetchCalls[0]!.body)
    expect(sent.get('hub.mode')).toBe('subscribe')
    expect(sent.get('hub.topic')).toBe('https://a.example/feed')
    expect(sent.get('hub.callback')).toMatch(/^https:\/\/reader\.example\/api\/websub\/[^/]+$/)
    expect(Number(sent.get('hub.lease_seconds'))).toBe(LEASE_SECONDS)

    const row = handle.db.select().from(feeds).get()
    expect(row!.websubHub).toBe('https://hub.example/')
    expect(row!.websubToken).not.toBeNull()
    expect(row!.websubLeaseUntil).toBe(epochMs(NOW + LEASE_SECONDS * 1000))
  })

  test('is a no-op while the lease is still live', async () => {
    const { handle, feedId } = setup()
    await ensureSubscribed(handle, feedId, 'https://a.example/feed', atomWithHub(), NOW)
    fetchCalls = []
    await ensureSubscribed(handle, feedId, 'https://a.example/feed', atomWithHub(), NOW + DAY)
    expect(fetchCalls).toHaveLength(0)
  })

  test('a refused subscription records no lease, so the next fetch retries', async () => {
    const { handle, feedId } = setup()
    hubAnswers = false
    await ensureSubscribed(handle, feedId, 'https://a.example/feed', atomWithHub(), NOW)
    const row = handle.db.select().from(feeds).get()
    expect(row!.websubHub).toBe('https://hub.example/')
    expect(row!.websubLeaseUntil).toBeNull()
    hubAnswers = true
    await ensureSubscribed(handle, feedId, 'https://a.example/feed', atomWithHub(), NOW)
    expect(handle.db.select().from(feeds).get()!.websubLeaseUntil).toBe(
      epochMs(NOW + LEASE_SECONDS * 1000),
    )
  })
})

describe('renewDue', () => {
  async function subscribed(handle: ReaderHandle, feedId: FeedId, leaseUntil: number | null) {
    await ensureSubscribed(handle, feedId, 'https://a.example/feed', atomWithHub(), NOW)
    handle.db
      .update(feeds)
      .set({ websubLeaseUntil: leaseUntil === null ? null : epochMs(leaseUntil) })
      .run()
    fetchCalls = []
  }

  test('renews a lease inside the 2-day window', async () => {
    const { handle, feedId } = setup()
    await subscribed(handle, feedId, NOW + DAY) // expires in 1 day
    const res = await renewDue(handle, NOW)
    expect(res.renewed).toBe(1)
    expect(fetchCalls).toHaveLength(1)
    expect(handle.db.select().from(feeds).get()!.websubLeaseUntil).toBe(
      epochMs(NOW + LEASE_SECONDS * 1000),
    )
  })

  test('leaves a comfortable lease alone', async () => {
    const { handle, feedId } = setup()
    await subscribed(handle, feedId, NOW + 6 * DAY)
    const res = await renewDue(handle, NOW)
    expect(res.renewed).toBe(0)
    expect(fetchCalls).toHaveLength(0)
  })

  test('retries a lease that was never granted', async () => {
    const { handle, feedId } = setup()
    await subscribed(handle, feedId, null)
    const res = await renewDue(handle, NOW)
    expect(res.renewed).toBe(1)
  })
})

describe('callback token', () => {
  test('is unguessable and addresses exactly one feed', () => {
    const a = newCallbackToken()
    const b = newCallbackToken()
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThanOrEqual(32)
    expect(callbackUrl(a)).toBe(`https://reader.example/api/websub/${a}`)
  })
})
