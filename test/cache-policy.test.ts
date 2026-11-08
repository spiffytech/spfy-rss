import { beforeAll, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SessionUser } from '../src/server/auth'
import {
  epochMs,
  newCategoryId,
  newFeedId,
  newIconId,
  newUserId,
  type UserId,
} from '../src/shared/ids'

const dbPath = join(mkdtempSync(join(tmpdir(), 'cache-policy-')), 'reader.sqlite')
process.env.READER_DB_PATH = dbPath
process.env.SESSION_SECRET = 'cache-policy'

const { default: middleware } = await import('../src/middleware')
const { handleApiRoute } = await import('../src/api-routes')
const { BUILD_ID } = await import('../src/shared/build')
const { signSession } = await import('../src/server/auth')
const { openDatabase } = await import('../src/server/db')

const NOW = 1_760_000_000_000
let user: SessionUser
let cookie = ''

beforeAll(() => {
  const handle = openDatabase(dbPath)
  const userId = newUserId(epochMs(NOW))
  user = { id: userId, username: 'spiffy' }
  cookie = `reader_session=${signSession(user)}`

  handle.sqlite.run(
    'INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)',
    [userId, 'spiffy', 'h', NOW],
  )
  const categoryId = newCategoryId(epochMs(NOW))
  handle.sqlite.run('INSERT INTO categories (id, user_id, title, created_at) VALUES (?, ?, ?, ?)', [
    categoryId,
    userId,
    'Tech',
    NOW,
  ])
  const feedId = newFeedId(epochMs(NOW))
  handle.sqlite.run(
    `INSERT INTO feeds (id, user_id, category_id, title, feed_url, websub_token, websub_hub, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      feedId,
      userId,
      categoryId,
      'Blog',
      'https://example.com/feed',
      'websub-token',
      'https://hub.example/',
      NOW,
    ],
  )
  const iconId = newIconId(epochMs(NOW))
  handle.sqlite.run('INSERT INTO icons (id, mime_type, data) VALUES (?, ?, ?)', [
    iconId,
    'image/png',
    new Uint8Array([1, 2, 3]),
  ])
  handle.sqlite.run('INSERT INTO feed_icons (feed_id, icon_id) VALUES (?, ?)', [feedId, iconId])
  handle.sqlite.close()
})

/** Run the real middleware with a fake handler body. */
const runMiddleware = async (path: string, opts: { cookie?: string; accept?: string } = {}) => {
  const headers: Record<string, string> = {}
  if (opts.cookie) headers['cookie'] = opts.cookie
  if (opts.accept) headers['accept'] = opts.accept
  const event = {
    request: new Request(`http://reader.test${path}`, { headers }),
    locals: {},
  } as unknown as Parameters<typeof middleware>[0]
  return (await middleware(
    event,
    async () =>
      new Response('<!doctype html><html><body>page</body></html>', {
        headers: { 'content-type': 'text/html' },
      }),
  )) as Response
}

const api = (path: string, signedIn = true) =>
  handleApiRoute(new Request(`http://reader.test${path}`), { user: signedIn ? user : null })

test('documents are private and always revalidated', async () => {
  const login = await runMiddleware('/login')
  expect(login.status).toBe(200)
  expect(login.headers.get('cache-control')).toBe('private, no-cache')

  const reader = await runMiddleware('/', { cookie })
  expect(reader.status).toBe(200)
  expect(reader.headers.get('cache-control')).toBe('private, no-cache')

  const signup = await runMiddleware('/signup')
  expect(signup.headers.get('cache-control')).toBe('private, no-cache')
})

test('server functions are never stored', async () => {
  const rpc = await runMiddleware('/_server/data/viewPanel-abc', { cookie })
  expect(rpc.status).toBe(200)
  expect(rpc.headers.get('cache-control')).toBe('private, no-store')
})

test('auth redirects and legacy redirects are never stored', async () => {
  const gate = await runMiddleware('/')
  expect(gate.status).toBe(302)
  expect(gate.headers.get('location')).toBe('/login')
  expect(gate.headers.get('cache-control')).toBe('no-store')

  const away = await runMiddleware('/login', { cookie })
  expect(away.status).toBe(302)
  expect(away.headers.get('location')).toBe('/')
  expect(away.headers.get('cache-control')).toBe('no-store')

  const legacy = await runMiddleware('/feed/abc', { accept: 'text/html' })
  expect(legacy.status).toBe(302)
  expect(legacy.headers.get('location')).toBe('/?feed=abc')
  expect(legacy.headers.get('cache-control')).toBe('no-store')
})

test('health is never cached: a stale 200 would mask an outage', async () => {
  const health = await api('/health', false)
  expect(health?.status).toBe(200)
  expect(health?.headers.get('cache-control')).toBe('no-store')

  const scheduler = await api('/health/scheduler', false)
  expect(scheduler?.headers.get('cache-control')).toBe('no-store')
})

test('the build id is public and uncached, and health reports it', async () => {
  const version = await api('/api/version', false)
  expect(version?.status).toBe(200)
  expect(version?.headers.get('cache-control')).toBe('no-store')
  const body = (await version?.json()) as { buildId: string }
  expect(body.buildId).toBe(BUILD_ID)

  // Health carries the same id, so "is the deploy live?" is answerable from
  // outside the box rather than inferred from an image tag.
  const health = await api('/health', false)
  expect(((await health?.json()) as { buildId: string }).buildId).toBe(BUILD_ID)
})

test('OPML is private and never stored', async () => {
  const exported = await api('/opml')
  expect(exported?.status).toBe(200)
  expect(exported?.headers.get('cache-control')).toBe('private, no-store')

  const anonymous = await api('/opml', false)
  expect(anonymous?.status).toBe(401)
  expect(anonymous?.headers.get('cache-control')).toBe('no-store')
})

test('feed icons opt into a day of private caching', async () => {
  const feedId = (await import('../src/server/db-app'))
    .appDb()
    .sqlite.query('SELECT id FROM feeds LIMIT 1')
    .get() as {
    id: string
  }
  const icon = await api(`/api/icons/${feedId.id}`)
  expect(icon?.status).toBe(200)
  expect(icon?.headers.get('cache-control')).toBe('private, max-age=86400')
})

test('WebSub handshakes are never stored', async () => {
  const verify = await api(
    '/api/websub/websub-token?hub.mode=subscribe&hub.challenge=abc&hub.topic=https%3A%2F%2Fexample.com%2Ffeed',
    false,
  )
  expect(verify?.status).toBe(200)
  expect(await verify?.text()).toBe('abc')
  expect(verify?.headers.get('cache-control')).toBe('no-store')
})

test('machine-facing paths never become a page', async () => {
  // Falling through to the auth gate answered `HEAD /health` (and any typo'd
  // probe) with 302 /login; a prober that follows redirects read 200 text/html.
  const unknown = await api('/api/nope')
  expect(unknown?.status).toBe(404)
  expect(unknown?.headers.get('cache-control')).toBe('no-store')

  const typo = await api('/health/schedulr', false)
  expect(typo?.status).toBe(404)

  const head = await handleApiRoute(new Request('http://reader.test/health', { method: 'HEAD' }), {
    user: null,
  })
  expect(head?.status).toBe(200)
})
