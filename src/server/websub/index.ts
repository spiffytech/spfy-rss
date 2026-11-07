/**
 * WebSub (formerly PubSubHubbub) — push delivery where a feed offers it.
 *
 * A feed that publishes `<link rel="hub">` gets subscribed; the hub then POSTs
 * to our callback whenever the feed changes, and we run the ordinary
 * `fetchAndIngest`. The poller is untouched and remains the fallback: a lapsed
 * lease degrades to polling rather than to silence, so the failure mode of this
 * whole feature is "we lose the upgrade", never "we stop fetching".
 *
 * Hubs vary — some push the full document, some just ping. We ignore the payload
 * entirely and refetch, which makes every hub behave identically.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, eq, isNotNull, isNull, lt, or } from 'drizzle-orm'

import { epochMs, type FeedId } from '../../shared/ids'
import type { ReaderHandle } from '../db'
import { feeds } from '../db/schema'

/** Lease we ask for. Hubs cap at ~10 days; asking for 8 leaves renewal comfortable. */
export const LEASE_SECONDS = 8 * 86400
/** Renew once the lease is inside this window. */
const RENEW_BELOW_SECONDS = 2 * 86400

/** Public origin of THIS app — hubs must be able to reach it. */
export function publicBaseUrl(): string {
  return (process.env.READER_PUBLIC_URL ?? '').replace(/\/+$/, '')
}

export function newCallbackToken(): string {
  return randomBytes(24).toString('base64url')
}

export function callbackUrl(token: string): string {
  return `${publicBaseUrl()}/api/websub/${token}`
}

/**
 * Pull `rel="hub"` and `rel="self"` out of a feed document. Deliberately a
 * shallow scan of the head rather than a full XML parse: this runs on every
 * fetch and must not cost anything on the common case.
 */
export function discoverHub(xml: string): { hub: string | null; self: string | null } {
  let hub: string | null = null
  let self: string | null = null
  const head = xml.length > 20_000 ? xml.slice(0, 20_000) : xml
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0]
    const rel = /\brel\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase() ?? ''
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? ''
    if (!href) continue
    const tokens = rel.split(/\s+/)
    if (tokens.includes('hub') && !hub) hub = href
    if (tokens.includes('self') && !self) self = href
  }
  return { hub, self }
}

/** Ask a hub to subscribe. Accepts 202 as well as 200 — most hubs answer 202. */
export async function subscribe(opts: {
  hub: string
  topic: string
  callback: string
  secret: string
  leaseSeconds?: number
}): Promise<boolean> {
  const body = new URLSearchParams({
    'hub.mode': 'subscribe',
    'hub.topic': opts.topic,
    'hub.callback': opts.callback,
    'hub.lease_seconds': String(opts.leaseSeconds ?? LEASE_SECONDS),
    'hub.secret': opts.secret,
  })
  try {
    const res = await fetch(opts.hub, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      console.warn('websub: hub refused subscribe', opts.hub, res.status, opts.topic)
      return false
    }
    return true
  } catch (error) {
    console.warn('websub: hub unreachable', opts.hub, opts.topic, error)
    return false
  }
}

/**
 * Record a discovered hub and subscribe if we are not already covered.
 * Called opportunistically after a normal fetch, so discovery costs nothing.
 */
export async function ensureSubscribed(
  handle: ReaderHandle,
  feedId: FeedId,
  feedUrl: string,
  xml: string,
  now = Date.now(),
): Promise<void> {
  const { db } = handle
  const row = db.select().from(feeds).where(eq(feeds.id, feedId)).get()
  if (!row) return

  const { hub, self } = discoverHub(xml)
  if (!hub) return // no hub advertised: polling is the mechanism, nothing to do

  const topic = self ?? feedUrl
  const covered =
    row.websubHub === hub && row.websubLeaseUntil != null && row.websubLeaseUntil > now + 60_000
  if (covered) return

  const token = row.websubToken ?? newCallbackToken()
  const ok = await subscribe({ hub, topic, callback: callbackUrl(token), secret: token })
  db.update(feeds)
    .set({
      websubHub: hub,
      websubToken: token,
      // Only claim a lease when the hub said yes; otherwise leave it null so
      // the next fetch tries again rather than believing a subscription exists.
      websubLeaseUntil: ok ? epochMs(now + LEASE_SECONDS * 1000) : null,
    })
    .where(eq(feeds.id, feedId))
    .run()
}

/**
 * Renew leases close to expiry. Safe to run often: a subscription that never
 * renews simply lapses back to polling.
 */
export async function renewDue(
  handle: ReaderHandle,
  now = Date.now(),
): Promise<{ renewed: number; failed: number }> {
  const { db } = handle
  const due = db
    .select()
    .from(feeds)
    .where(
      and(
        isNotNull(feeds.websubHub),
        or(
          // never granted a lease in the first place: retry discovery
          isNull(feeds.websubLeaseUntil),
          // or it is close enough to expiry to be worth renewing
          lt(feeds.websubLeaseUntil, epochMs(now + RENEW_BELOW_SECONDS * 1000)),
        ),
      ),
    )
    .all()

  let renewed = 0
  let failed = 0
  for (const f of due) {
    const ok = await subscribe({
      hub: f.websubHub as string,
      topic: f.feedUrl,
      callback: callbackUrl(f.websubToken ?? newCallbackToken()),
      secret: f.websubToken ?? '',
    })
    if (ok) {
      renewed++
      db.update(feeds)
        .set({ websubLeaseUntil: epochMs(now + LEASE_SECONDS * 1000) })
        .where(eq(feeds.id, f.id))
        .run()
    } else {
      failed++
    }
  }
  return { renewed, failed }
}

/**
 * `X-Hub-Signature: sha1=<hex>` over the raw body with our per-feed secret.
 * Returns true when the header is absent too — the unguessable callback token
 * is what stops strangers, and some hubs do not sign at all. This is belt and
 * braces against cross-feed misdelivery.
 */
export function verifySignature(secret: string, rawBody: string, header: string | null): boolean {
  if (!header) return true
  const m = /^sha1=([0-9a-f]+)$/i.exec(header)
  if (!m || !secret) return false
  const expected = createHmac('sha1', secret).update(rawBody).digest('hex')
  const a = Buffer.from(expected, 'hex')
  const b = Buffer.from(m[1] as string, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}
