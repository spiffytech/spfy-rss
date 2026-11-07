/**
 * Dev-mode smoke test: `vite dev`, not the built bundle.
 *
 * The behavior suite drives `bun server.ts` over `dist/`, where Solid's dev-only
 * diagnostics are warn-and-continue. In `vite dev` several of them *throw*, and a
 * thrown diagnostic halts the reactive system — after which the app still renders,
 * clicks still fire, and nothing happens. That is invisible to every test that
 * drives the built app, and it is exactly how "I cannot click between feeds"
 * reached a browser: the halt came from `onSettled` returning a cleanup inside a
 * ref callback (SETTLED_CLEANUP_UNOWNED), a diagnostic that only dev reports.
 *
 * So this suite runs the *dev* server and fails on any fault the page raises,
 * which covers every diagnostic that escalates to an error.
 *
 * Run with `bun run test:dev` (needs the same headless-browser environment as the
 * behavior suite).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { signSession } from '../src/server/auth'
import { openDatabase } from '../src/server/db'
import { epochMs, newCategoryId, newEntryId, newFeedId, newUserId } from '../src/shared/ids'

const enabled = process.env.WEBVIEW === '1'
const PORT = 4821
const BASE = `http://localhost:${PORT}`
const SECRET = 'dev-smoke'

let server: ReturnType<typeof spawn> | undefined
let cookie = ''

/** Fail fast instead of testing whatever else is on the port. */
const portIsBusy = async (): Promise<boolean> =>
  fetch(`${BASE}/login`).then(
    () => true,
    () => false,
  )

beforeAll(async () => {
  if (!enabled) return
  if (await portIsBusy()) {
    throw new Error(`port ${PORT} is already serving — kill the leftover server first`)
  }

  const dbPath = join(mkdtempSync(join(tmpdir(), 'dev-smoke-db-')), 'reader.sqlite')
  const handle = openDatabase(dbPath)
  const now = epochMs(Date.now())
  const userId = newUserId(now)
  handle.sqlite.run(
    'INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)',
    [userId, 'spiffy', Bun.password.hashSync('x', { algorithm: 'argon2id' }), now],
  )
  const categoryId = newCategoryId(now)
  handle.sqlite.run('INSERT INTO categories (id, user_id, title, created_at) VALUES (?, ?, ?, ?)', [
    categoryId,
    userId,
    'Tech',
    now,
  ])
  // Three feeds, so "click through feeds" is a real sequence.
  for (const title of ['Blog', 'Comics', 'News']) {
    const feedId = newFeedId(now)
    handle.sqlite.run(
      'INSERT INTO feeds (id, user_id, category_id, title, feed_url, site_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        feedId,
        userId,
        categoryId,
        title,
        `https://example.com/${title}`,
        'https://example.com/',
        now,
      ],
    )
    const insert = handle.sqlite.prepare(
      `INSERT INTO entries (id, user_id, feed_id, hash, title, content, published_at, created_at, changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (let i = 1; i <= 3; i++) {
      insert.run(
        newEntryId(now),
        userId,
        feedId,
        `h${title}${i}`,
        `${title} ${i}`,
        '<p>b</p>',
        now + i * 1000,
        now,
        now,
      )
    }
  }
  handle.sqlite.close()

  process.env.SESSION_SECRET = SECRET
  cookie = signSession({ id: userId as never, username: 'spiffy' })

  server = spawn('bun', ['--bun', 'vite', 'dev', '--port', String(PORT), '--strictPort'], {
    env: {
      ...process.env,
      READER_DB_PATH: dbPath,
      SESSION_SECRET: SECRET,
      SCHEDULER_ENABLED: '0',
      NODE_ENV: '',
    },
    stdio: 'ignore',
  })

  // Vite answers before its SSR module graph is warm, so wait for a real render.
  for (let i = 0; i < 300; i++) {
    try {
      const res = await fetch(`${BASE}/login`)
      if (res.ok) break
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
})

afterAll(() => {
  if (typeof Bun !== 'undefined' && 'WebView' in Bun) Bun.WebView.closeAll()
  server?.kill()
})

const it = enabled ? test : test.skip

const until = (script: string, timeoutMs = 15_000): string => `
  (() => {
    const deadline = Date.now() + ${timeoutMs}
    return new Promise((resolve) => {
      const tick = () => {
        const v = (() => { ${script} })()
        if (v) return resolve(v)
        if (Date.now() > deadline) return resolve(v)
        setTimeout(tick, 100)
      }
      tick()
    })
  })()
`

it('dev mode: clicking through feeds navigates every time, with no page faults', async () => {
  const messages: string[] = []
  const view = new Bun.WebView({
    width: 1100,
    height: 800,
    console: (type, ...args) => messages.push(`[${type}] ${args.map(String).join(' ')}`),
  })
  try {
    await view.navigate(`${BASE}/login`)
    await view.evaluate(`document.cookie = 'reader_session=${cookie}; path=/'`)
    await view.navigate(`${BASE}/`)
    const ready = (await view.evaluate(
      until('return document.querySelectorAll(".app-sidebar a").length > 3 ? 1 : 0', 30_000),
    )) as number
    expect(ready).toBe(1)

    // Collect faults from here on: a fault during load would have broken the
    // render above, which that assertion already covers.
    await view.evaluate(`
        (() => {
          window.__faults = []
          window.addEventListener('error', (e) =>
            window.__faults.push('error: ' + ((e.error && e.error.stack) || e.message)))
          window.addEventListener('unhandledrejection', (e) =>
            window.__faults.push('rejection: ' + ((e.reason && e.reason.stack) || String(e.reason))))
          return true
        })()
      `)

    const visited: string[] = []
    // Feed links only: the sidebar's section links (Home, Starred) are views
    // with no entries to land in, and position is not what this is testing.
    const feedLinks = (await view.evaluate(
      `[...document.querySelectorAll('.app-sidebar a')].map((a) => a.getAttribute('href') || '').filter((href) => href.includes('feed=')).slice(0, 3)`,
    )) as string[]
    expect(feedLinks.length).toBe(3)
    for (const target of feedLinks) {
      await view.evaluate(
        `[...document.querySelectorAll('.app-sidebar a')].find((a) => a.getAttribute('href') === ${JSON.stringify(target)}).click()`,
      )
      const landed = (await view.evaluate(
        until(
          `const want = ${JSON.stringify(target)}; return location.pathname + location.search === want ? want : ''`,
          10_000,
        ),
      )) as string
      expect(landed).toBe(target)
      visited.push(landed)
      const rows = (await view.evaluate(
        until(
          'const n = document.querySelectorAll("[data-entry-id]").length; return n > 0 ? n : 0',
        ),
      )) as number
      expect(rows).toBeGreaterThan(0)
    }
    expect(new Set(visited).size).toBe(visited.length)

    const faults = JSON.parse(
      (await view.evaluate('JSON.stringify(window.__faults || [])')) as string,
    ) as string[]
    expect(faults).toEqual([])

    // A diagnostic that dev escalates is reported through the console even when
    // it does not throw — catch those too, since each one is a bug in the app.
    const escalated = messages.filter((m) =>
      /REACTIVITY_HALTED|SETTLED_CLEANUP_UNOWNED|INVALID_|UNTRACKED_READ_AFTER_AWAIT/.test(m),
    )
    expect(escalated).toEqual([])
  } finally {
    await view.close()
  }
}, 120_000)
