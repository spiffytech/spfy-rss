/**
 * Feed transport: one conditional GET with the whole outcome space named.
 *
 * Outcomes are a discriminated union (`ok | not-modified | rate-limited |
 * error`) so callers must handle every case. Redirects are followed manually
 * so a permanent move (301/308) can update the stored `feed_url`. The body is
 * size-capped and decoded per the NewsBlur charset rule (charset-less
 * Content-Type means UTF-8, not Windows-1252).
 */
import type { EpochMs } from '../../shared/ids'
import { epochMs } from '../../shared/ids'
import { decodeBody } from './quirks'

export type FetchOutcome =
  | {
      kind: 'ok'
      body: string
      etag: string | null
      lastModified: string | null
      finalUrl: string
      permanentlyMoved: boolean
      fetchedAt: EpochMs
      /** Cache freshness (max-age / Expires): a "not before" hint, ms. */
      freshnessMs: number | null
    }
  | { kind: 'not-modified'; fetchedAt: EpochMs; freshnessMs: number | null }
  | { kind: 'rate-limited'; retryAfterMs: number | null; fetchedAt: EpochMs }
  | { kind: 'error'; message: string; httpStatus: number | null; fetchedAt: EpochMs }

const MAX_REDIRECTS = 5
const DEFAULT_MAX_BYTES = 15 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const at = Date.parse(value)
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now())
}

/** Cache freshness: `max-age`, else `Expires` minus now. Null = the origin
 *  promised nothing. Honoured as a floor, never as a target. */
function parseFreshnessMs(headers: Headers): number | null {
  const cc = headers.get('cache-control')
  if (cc) {
    const m = /max-age=(\d+)/i.exec(cc)
    if (m) return Math.max(0, Number(m[1]) * 1000)
  }
  const exp = headers.get('expires')
  if (exp) {
    const at = Date.parse(exp)
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now())
  }
  return null
}

async function readCapped(
  response: Response,
  maxBytes: number,
  fetchedAt: EpochMs,
): Promise<Uint8Array | FetchOutcome> {
  const body = response.body
  if (!body) return new Uint8Array(0)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        return {
          kind: 'error',
          message: `feed exceeds ${maxBytes} bytes`,
          httpStatus: response.status,
          fetchedAt,
        }
      }
      chunks.push(value)
    }
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export async function fetchFeed(
  url: string,
  opts: {
    etag?: string | null
    lastModified?: string | null
    timeoutMs?: number
    maxBytes?: number
    userAgent?: string
  } = {},
): Promise<FetchOutcome> {
  const fetchedAt = epochMs(Date.now())
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  let current = url
  let permanentlyMoved = false

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const headers: Record<string, string> = {
      'user-agent': opts.userAgent ?? 'reader/0.1 (+self-hosted; one process, polite intervals)',
      accept:
        'application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8',
    }
    if (opts.etag) headers['if-none-match'] = opts.etag
    if (opts.lastModified) headers['if-modified-since'] = opts.lastModified

    let response: Response
    try {
      response = await fetch(current, {
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      })
    } catch (error) {
      return { kind: 'error', message: String(error), httpStatus: null, fetchedAt }
    }

    if (response.status === 304)
      return { kind: 'not-modified', fetchedAt, freshnessMs: parseFreshnessMs(response.headers) }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location)
        return {
          kind: 'error',
          message: `redirect without location (HTTP ${response.status})`,
          httpStatus: response.status,
          fetchedAt,
        }
      if (response.status === 301 || response.status === 308) permanentlyMoved = true
      try {
        current = new URL(location, current).toString()
      } catch {
        return {
          kind: 'error',
          message: `unparseable redirect target: ${location}`,
          httpStatus: response.status,
          fetchedAt,
        }
      }
      continue
    }
    if (response.status === 304)
      return { kind: 'not-modified', fetchedAt, freshnessMs: parseFreshnessMs(response.headers) }
    if (response.status === 429 || response.status === 503) {
      return {
        kind: 'rate-limited',
        retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
        fetchedAt,
      }
    }
    if (!response.ok) {
      return {
        kind: 'error',
        message: `HTTP ${response.status}`,
        httpStatus: response.status,
        fetchedAt,
      }
    }

    const bytes = await readCapped(response, maxBytes, fetchedAt)
    if (!(bytes instanceof Uint8Array)) return bytes
    return {
      kind: 'ok',
      body: decodeBody(bytes, response.headers.get('content-type')),
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
      finalUrl: current,
      permanentlyMoved,
      fetchedAt,
      freshnessMs: parseFreshnessMs(response.headers),
    }
  }
  return {
    kind: 'error',
    message: `too many redirects (>${MAX_REDIRECTS})`,
    httpStatus: null,
    fetchedAt,
  }
}
