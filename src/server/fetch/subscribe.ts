/**
 * Adding a feed and changing a feed's URL. Both share one rule: the URL must
 * fetch and parse *before* anything is written, so a typo never leaves a junk
 * subscription behind.
 *
 * A site URL (HTML) is accepted too: when it does not parse as a feed, the
 * document's `<link rel="alternate">` advertisements are tried in order.
 */
import { and, eq } from 'drizzle-orm'

import type { FeedId, UserId } from '../../shared/ids'
import type { FeedSaveResult } from '../../shared/types'
import type { ReaderHandle } from '../db'
import { feeds } from '../db/schema'
import {
  fallbackTitle,
  feedIdByUrl,
  fetchIconFor,
  insertSubscription,
  ownedFeed,
  resolveFolder,
  updateFeedRow,
  type FolderChoice,
  type FolderResult,
} from '../query/feed-admin'
import { discoverAlternateFeeds } from './discover'
import { parseFeedBody, type ParsedFeed } from './parse'
import type { FetchOutcome } from './transport'
import { fetchFeed } from './transport'

type OkOutcome = Extract<FetchOutcome, { kind: 'ok' }>
const MAX_DISCOVERED = 5

/** Scheme-less input is treated as https; only http(s) is fetched. */
export function normalizeFeedUrl(input: string): string | null {
  const trimmed = input.trim()
  if (trimmed === '') return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString()
  } catch {
    return null
  }
}

type Resolved = { ok: true; finalUrl: string; outcome: OkOutcome; parsed: ParsedFeed }
type ResolveFailure = { ok: false; reason: 'fetch' | 'parse'; detail?: string }

function parseOutcome(outcome: OkOutcome, feedUrl: string): ParsedFeed | null {
  try {
    return parseFeedBody(outcome.body, feedUrl)
  } catch {
    return null
  }
}

/**
 * Fetch and parse a URL, falling back to feed discovery when the document is a
 * web page. Each discovered candidate gets one fetch; the first parseable one
 * wins. Failures are data, not exceptions.
 */
export async function resolveFeed(input: string): Promise<Resolved | ResolveFailure> {
  const url = normalizeFeedUrl(input)
  if (url === null) return { ok: false, reason: 'parse', detail: 'invalid URL' }

  const first = await fetchFeed(url)
  if (first.kind === 'error') return { ok: false, reason: 'fetch', detail: first.message }
  if (first.kind === 'rate-limited') {
    return { ok: false, reason: 'fetch', detail: 'the site asked us to back off' }
  }
  if (first.kind !== 'ok') return { ok: false, reason: 'fetch', detail: 'unexpected response' }

  const direct = parseOutcome(first, first.finalUrl)
  if (direct) return { ok: true, finalUrl: first.finalUrl, outcome: first, parsed: direct }

  const candidates = discoverAlternateFeeds(first.body, first.finalUrl)
    .filter((candidate) => candidate !== first.finalUrl)
    .slice(0, MAX_DISCOVERED)

  for (const candidate of candidates) {
    const outcome = await fetchFeed(candidate)
    if (outcome.kind !== 'ok') continue
    const parsed = parseOutcome(outcome, outcome.finalUrl)
    if (parsed) return { ok: true, finalUrl: outcome.finalUrl, outcome, parsed }
  }

  return {
    ok: false,
    reason: 'parse',
    detail: candidates.length > 0 ? 'no advertised feed could be parsed' : 'not a feed',
  }
}

function folderOf(handle: ReaderHandle, userId: UserId, choice: FolderChoice): FolderResult {
  return resolveFolder(handle, userId, choice)
}

export async function subscribe(
  handle: ReaderHandle,
  opts: {
    userId: UserId
    url: string
    title?: string | undefined
    now?: number
  } & FolderChoice,
): Promise<FeedSaveResult> {
  const url = normalizeFeedUrl(opts.url)
  if (url === null) return { ok: false, reason: 'invalid_url' }
  const existingId = feedIdByUrl(handle, opts.userId, url)
  if (existingId) return { ok: false, reason: 'duplicate', feedId: existingId }

  const resolved = await resolveFeed(url)
  if (!resolved.ok) return resolved
  // The input URL can differ from the stored URL after a redirect or discovery.
  const finalId = feedIdByUrl(handle, opts.userId, resolved.finalUrl)
  if (finalId) return { ok: false, reason: 'duplicate', feedId: finalId }

  const folder = folderOf(handle, opts.userId, opts)
  if (!folder.ok) return folder

  const title = (opts.title ?? '').trim() || fallbackTitle(resolved.parsed.title, resolved.finalUrl)
  const feedId = insertSubscription(handle, {
    userId: opts.userId,
    categoryId: folder.categoryId,
    title,
    feedUrl: resolved.finalUrl,
    siteUrl: resolved.parsed.siteUrl,
    outcome: resolved.outcome,
    parsed: resolved.parsed,
    ...(opts.now === undefined ? {} : { now: opts.now }),
  })
  await fetchIconFor(handle, feedId, resolved.parsed, resolved.finalUrl)
  return { ok: true, feedId, urlChanged: false }
}

/** Does another feed of this user already own that URL? */
function urlTakenByOther(
  handle: ReaderHandle,
  userId: UserId,
  feedUrl: string,
  feedId: FeedId,
): boolean {
  const row = handle.db
    .select({ id: feeds.id })
    .from(feeds)
    .where(and(eq(feeds.userId, userId), eq(feeds.feedUrl, feedUrl)))
    .get()
  return row !== undefined && row.id !== feedId
}

export async function editFeed(
  handle: ReaderHandle,
  opts: {
    userId: UserId
    feedId: FeedId
    title?: string | undefined
    feedUrl?: string | undefined
    now?: number
  } & FolderChoice,
): Promise<FeedSaveResult> {
  const existing = ownedFeed(handle, opts.userId, opts.feedId)
  if (!existing) return { ok: false, reason: 'not_found' }

  const title = (opts.title ?? '').trim() || existing.title
  const nextUrl = opts.feedUrl === undefined ? existing.feedUrl : normalizeFeedUrl(opts.feedUrl)
  if (nextUrl === null) return { ok: false, reason: 'invalid_url' }

  if (nextUrl !== existing.feedUrl) {
    if (urlTakenByOther(handle, opts.userId, nextUrl, opts.feedId)) {
      return { ok: false, reason: 'duplicate' }
    }
    const resolved = await resolveFeed(nextUrl)
    if (!resolved.ok) return resolved
    if (urlTakenByOther(handle, opts.userId, resolved.finalUrl, opts.feedId)) {
      return { ok: false, reason: 'duplicate' }
    }

    const folder = folderOf(handle, opts.userId, opts)
    if (!folder.ok) return folder

    updateFeedRow(handle, {
      userId: opts.userId,
      feedId: opts.feedId,
      title,
      categoryId: folder.categoryId,
      feedUrl: resolved.finalUrl,
      siteUrl: resolved.parsed.siteUrl,
      outcome: resolved.outcome,
      ...(opts.now === undefined ? {} : { now: opts.now }),
    })
    await fetchIconFor(handle, opts.feedId, resolved.parsed, resolved.finalUrl)
    return { ok: true, feedId: opts.feedId, urlChanged: true }
  }

  const folder = folderOf(handle, opts.userId, opts)
  if (!folder.ok) return folder

  updateFeedRow(handle, {
    userId: opts.userId,
    feedId: opts.feedId,
    title,
    categoryId: folder.categoryId,
    feedUrl: existing.feedUrl,
    siteUrl: existing.siteUrl,
    ...(opts.now === undefined ? {} : { now: opts.now }),
  })
  return { ok: true, feedId: opts.feedId, urlChanged: false }
}
