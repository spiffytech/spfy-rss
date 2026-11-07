import { afterEach, beforeEach, expect, test } from 'bun:test'

import { fetchFeed } from '../src/server/fetch/transport'

let server: ReturnType<typeof Bun.serve>
let base: string

beforeEach(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname
      switch (path) {
        case '/feed':
          return new Response('<rss/>', {
            headers: {
              'content-type': 'text/xml',
              etag: 'W/"abc"',
              'last-modified': 'Thu, 01 Jan 2026 00:00:00 GMT',
            },
          })
        case '/cached':
          return req.headers.get('if-none-match') === 'W/"abc"'
            ? new Response(null, { status: 304 })
            : new Response('<rss/>', { headers: { etag: 'W/"abc"' } })
        case '/rate':
          return new Response('slow down', { status: 429, headers: { 'retry-after': '5' } })
        case '/moved':
          return Response.redirect(`${base}/feed`, 301)
        case '/broken':
          return new Response('boom', { status: 500 })
        case '/big':
          return new Response('x'.repeat(1024), { headers: { 'content-type': 'text/xml' } })
        case '/latin1':
          return new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), {
            headers: { 'content-type': 'text/xml; charset=iso-8859-1' },
          })
        default:
          return new Response('nf', { status: 404 })
      }
    },
  })
  base = `http://localhost:${server.port}`
})

afterEach(() => {
  server.stop(true)
})

test('conditional GET: 200 carries body, etag and last-modified', async () => {
  const outcome = await fetchFeed(`${base}/feed`)
  if (outcome.kind !== 'ok') throw new Error(`expected ok, got ${outcome.kind}`)
  expect(outcome.body).toBe('<rss/>')
  expect(outcome.etag).toBe('W/"abc"')
  expect(outcome.lastModified).toBe('Thu, 01 Jan 2026 00:00:00 GMT')
  expect(outcome.permanentlyMoved).toBe(false)
})

test('304 becomes not-modified', async () => {
  const outcome = await fetchFeed(`${base}/cached`, { etag: 'W/"abc"' })
  expect(outcome.kind).toBe('not-modified')
})

test('429 with Retry-After becomes rate-limited', async () => {
  const outcome = await fetchFeed(`${base}/rate`)
  if (outcome.kind !== 'rate-limited') throw new Error(`expected rate-limited, got ${outcome.kind}`)
  expect(outcome.retryAfterMs).toBe(5000)
})

test('301 marks a permanent move and reports the final URL', async () => {
  const outcome = await fetchFeed(`${base}/moved`)
  if (outcome.kind !== 'ok') throw new Error(`expected ok, got ${outcome.kind}`)
  expect(outcome.permanentlyMoved).toBe(true)
  expect(outcome.finalUrl).toBe(`${base}/feed`)
})

test('5xx is an error outcome, not a throw', async () => {
  const outcome = await fetchFeed(`${base}/broken`)
  if (outcome.kind !== 'error') throw new Error(`expected error, got ${outcome.kind}`)
  expect(outcome.httpStatus).toBe(500)
})

test('oversize feeds are cut off', async () => {
  const outcome = await fetchFeed(`${base}/big`, { maxBytes: 100 })
  if (outcome.kind !== 'error') throw new Error(`expected error, got ${outcome.kind}`)
  expect(outcome.message).toContain('exceeds')
})

test('charset from the header wins over the UTF-8 fallback', async () => {
  const outcome = await fetchFeed(`${base}/latin1`)
  if (outcome.kind !== 'ok') throw new Error(`expected ok, got ${outcome.kind}`)
  expect(outcome.body).toBe('café')
})
