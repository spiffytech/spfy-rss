import { eq } from 'drizzle-orm'

import type { SessionUser } from './server/auth'
import type { FeedId } from './shared/ids'
import { appDb } from './server/db-app'
import { feedIcons, feeds, icons } from './server/db/schema'
import { fetchAndIngest } from './server/fetch/fetch-feed'
import { livenessReport, schedulerReport, type HealthReport } from './server/health'
import { loadSchedulerConfig } from './server/scheduler/config'
import { readHeartbeat } from './server/scheduler/heartbeat'
import { exportOpml } from './server/opml'
import { verifySignature } from './server/websub'

export interface ApiContext {
  user: SessionUser | null
}

const json = (data: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })

/**
 * Public URL endpoints: things an outside caller hits with a URL rather than a
 * typed function call. They are not server functions — a hub signs its own
 * POST, monitoring has no session, and an <img src> cannot speak the RPC
 * protocol.
 *
 * Mounted from middleware so `vite dev` and the production server behave
 * identically.
 */
export const handleApiRoute = async (
  request: Request,
  context: ApiContext,
): Promise<Response | null> => {
  const url = new URL(request.url)
  const path = url.pathname

  if (path === '/health' && request.method === 'GET') return healthResponse()
  if (path === '/health/scheduler' && request.method === 'GET') return schedulerHealthResponse()
  if (path === '/opml' && request.method === 'GET') return opmlResponse(context.user)

  if (path.startsWith('/api/websub/')) return webSubResponse(request, url)

  const icon = path.match(/^\/api\/icons\/([^/]+)$/)
  if (icon && request.method === 'GET') return iconResponse(icon[1]!, context.user)

  return null
}

/** SCHEDULER_MAX_TICK_AGE_MINUTES, or the same 5-minute default when the
 *  config is unreadable (the scheduler then never started at all). */
const staleAfterMinutes = (): number => {
  try {
    return loadSchedulerConfig().maxTickAgeMinutes
  } catch {
    return 5
  }
}

const toResponse = (report: HealthReport): Response => json(report.body, { status: report.status })

/**
 * Liveness: can this process serve, and does its database answer? That is what a
 * container healthcheck is allowed to act on — restarting does not fix a lagging
 * poller, and the first tick after a cold start can legitimately take minutes.
 * The scheduler rides along in the body (and as `degraded`) without moving the
 * status.
 */
const healthResponse = (): Response => {
  const probe = () => {
    appDb().sqlite.query('select 1').get()
  }
  const report = livenessReport(probe, readHeartbeat(), staleAfterMinutes())
  if (report.status !== 200) console.error('health: database probe failed')
  return toResponse(report)
}

/**
 * Poller liveness on its own URL (see docs/feed-scheduler.md): 503 once the last
 * completed tick ages past SCHEDULER_MAX_TICK_AGE_MINUTES, or when it has never
 * completed one. A disabled scheduler answers 200 — a stopped poller is a
 * choice, not a fault.
 */
const schedulerHealthResponse = (): Response =>
  toResponse(schedulerReport(readHeartbeat(), staleAfterMinutes()))

/**
 * OPML export. Authenticated like the reader itself: it is a complete map of
 * one account's subscriptions. The old app's Miniflux import/export namespace
 * is not emitted — this is plain OPML 2.0.
 */
const opmlResponse = (user: SessionUser | null): Response => {
  if (!user) return new Response('not authenticated', { status: 401 })
  return new Response(exportOpml(appDb(), user.id), {
    headers: {
      'content-type': 'text/x-opml; charset=utf-8',
      'content-disposition': 'attachment; filename="subscriptions.opml"',
    },
  })
}

/**
 * One feed's icon. Authenticated, but deliberately not owner-scoped: what it
 * returns is a favicon, a public web asset the feed's own site serves, and feed
 * ids are UUIDv7s (74 random bits), so there is nothing here to enumerate. This
 * matched the pre-port behaviour and stays that way until user scoping is a
 * deliberate, tested decision.
 */
const feedIcon = (feedId: string) =>
  appDb()
    .db.select({ mimeType: icons.mimeType, data: icons.data })
    .from(feedIcons)
    .innerJoin(icons, eq(feedIcons.iconId, icons.id))
    .where(eq(feedIcons.feedId, feedId as FeedId))
    .get()

const iconResponse = (feedId: string, user: SessionUser | null): Response => {
  if (!user) return new Response('not authenticated', { status: 401 })
  const row = feedIcon(feedId)
  if (!row) return new Response('no icon', { status: 404 })
  return new Response(new Uint8Array(row.data), {
    headers: {
      'content-type': row.mimeType,
      'cache-control': 'private, max-age=86400',
    },
  })
}

/**
 * WebSub callback. Deliberately UNAUTHENTICATED — hubs POST here as themselves.
 * The per-feed token in the URL is what makes this safe: it is 32 bytes of
 * randomness and is the only way to address a feed, so a stranger cannot aim a
 * notification at one, nor make us fetch anything but a feed's own URL. The same
 * token doubles as the HMAC secret.
 *
 * GET  — hub verification: echo hub.challenge
 * POST — a notification arrived: refetch that feed now
 */
const webSubResponse = async (request: Request, url: URL): Promise<Response> => {
  const token = url.pathname.slice('/api/websub/'.length)
  const db = appDb()

  if (request.method === 'GET') {
    const mode = url.searchParams.get('hub.mode')
    const challenge = url.searchParams.get('hub.challenge')
    const topic = url.searchParams.get('hub.topic')
    if (mode !== 'subscribe' && mode !== 'unsubscribe')
      return new Response('bad mode', { status: 400 })
    if (!challenge) return new Response('no challenge', { status: 400 })
    const feed = db.db.select().from(feeds).where(eq(feeds.websubToken, token)).get()
    if (!feed) return new Response('unknown subscription', { status: 404 })
    // The hub tells us which topic it thinks it is verifying. Refuse a mismatch
    // so one feed's token can never be used to verify another's.
    if (topic && topic !== feed.feedUrl) {
      console.warn('websub: verification refused, topic mismatch', feed.feedUrl, 'vs', topic)
      return new Response('topic mismatch', { status: 404 })
    }

    // On unsubscribe the hub is confirming a teardown: drop the lease so the
    // scheduler knows to keep polling rather than wait for a push that is not
    // coming.
    if (mode === 'unsubscribe') {
      db.db.update(feeds).set({ websubLeaseUntil: null }).where(eq(feeds.id, feed.id)).run()
    }
    // The only place a hub's verification becomes observable: a granted lease
    // (websub_lease_until in the future) is proof this GET answered.
    console.log('websub: verified', mode, JSON.stringify(feed.title), feed.feedUrl)
    return new Response(challenge, { status: 200, headers: { 'content-type': 'text/plain' } })
  }

  if (request.method === 'POST') {
    const raw = await request.text()
    const feed = db.db.select().from(feeds).where(eq(feeds.websubToken, token)).get()
    if (!feed) return new Response('unknown subscription', { status: 404 })
    if (!verifySignature(feed.websubToken ?? '', raw, request.headers.get('x-hub-signature'))) {
      console.warn('websub: notification rejected, bad signature', JSON.stringify(feed.title))
      return new Response('bad signature', { status: 403 })
    }
    // The payload is ignored on purpose: hubs differ (full document vs bare
    // ping) and the feed is the source of truth anyway. One fetch makes them
    // all alike.
    try {
      await fetchAndIngest({ handle: db, feedId: feed.id })
    } catch (error) {
      // A failed fetch is not the hub's problem. A 2xx keeps the subscription
      // alive and the poller catches whatever we missed — but say so, or a hub
      // delivering into a broken ingest looks exactly like a hub not delivering.
      console.error('websub: notification fetch failed', JSON.stringify(feed.title), error)
      return new Response(null, { status: 200 })
    }
    console.log('websub: notification', JSON.stringify(feed.title), `${raw.length}B`)
    return new Response(null, { status: 200 })
  }

  return new Response('method not allowed', { status: 405 })
}
