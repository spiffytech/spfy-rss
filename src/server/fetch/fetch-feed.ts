/**
 * Ingest one fetched feed into the DB: parse → hash identity → upsert.
 *
 * Resurrection guard: rows with `status='removed'` are never touched, and the
 * UNIQUE(feed_id, hash) constraint closes the insert path — imported
 * tombstone stubs live inside the same mechanism.
 *
 * `changed_at` only moves when content actually changed; `reading_time` is
 * preserved across unchanged re-fetches and recomputed only on real content
 * changes (imported Miniflux values are otherwise left verbatim).
 */
import type { Database, SQLQueryBindings } from 'bun:sqlite'
import { and, eq } from 'drizzle-orm'

import { epochMs, newEntryId, type EntryId, type FeedId } from '../../shared/ids'
import type { ReaderHandle } from '../db'
import { entries, feeds } from '../db/schema'
import { syncEntrySearch, type SearchRow } from '../db/search-sync'
import { estimateReadingTime } from '../reader/reading-time'
import { parseFeedBody, type ParsedItem } from './parse'
import { ensureSubscribed } from '../websub'
import type { FetchOutcome } from './transport'
import { fetchFeed } from './transport'
import { ensureFeedIcon } from './icons'

export type IngestResult =
  | {
      kind: 'ok'
      inserted: number
      updated: number
      moved: boolean
      iconUrl: string | null
      siteUrl: string | null
      freshnessMs: number | null
    }
  | { kind: 'not-modified'; freshnessMs: number | null }
  | { kind: 'rate-limited'; retryAfterMs: number | null }
  | { kind: 'error'; message: string }

function searchRowOf(sqlite: Database, id: EntryId): SearchRow {
  const row = sqlite
    .query<SearchRow, SQLQueryBindings[]>('SELECT rowid, title, content FROM entries WHERE id = ?')
    .get(id)
  if (!row) throw new Error(`entry ${id} vanished mid-ingest`)
  return row
}

function differs(existing: typeof entries.$inferSelect, item: ParsedItem): boolean {
  return (
    existing.title !== item.title ||
    existing.url !== item.url ||
    existing.author !== item.author ||
    existing.content !== item.content ||
    JSON.stringify(existing.tags) !== JSON.stringify(item.tags)
  )
}

export function ingestFeedOutcome(opts: {
  handle: ReaderHandle
  feedId: FeedId
  outcome: FetchOutcome
  now?: number
}): IngestResult {
  const { sqlite, db } = opts.handle
  const outcome = opts.outcome
  const now = opts.now ?? Date.now()

  if (outcome.kind === 'rate-limited') {
    return { kind: 'rate-limited', retryAfterMs: outcome.retryAfterMs }
  }

  const feed = db.select().from(feeds).where(eq(feeds.id, opts.feedId)).get()
  if (!feed) return { kind: 'error', message: `unknown feed ${opts.feedId}` }

  const bumpErrors = (checkedAt: number, message: string) => {
    db.update(feeds)
      .set({
        checkedAt: epochMs(checkedAt),
        parsingErrorCount: feed.parsingErrorCount + 1,
        lastError: message.slice(0, 500),
        lastErrorAt: epochMs(checkedAt),
      })
      .where(eq(feeds.id, feed.id))
      .run()
  }

  if (outcome.kind === 'not-modified') {
    db.update(feeds)
      .set({ checkedAt: outcome.fetchedAt, lastError: null, lastErrorAt: null })
      .where(eq(feeds.id, feed.id))
      .run()
    return { kind: 'not-modified', freshnessMs: outcome.freshnessMs }
  }

  if (outcome.kind === 'error') {
    bumpErrors(outcome.fetchedAt, outcome.message)
    return { kind: 'error', message: outcome.message }
  }

  let parsed
  try {
    parsed = parseFeedBody(outcome.body, feed.feedUrl, { now })
  } catch (error) {
    bumpErrors(outcome.fetchedAt, String(error))
    return { kind: 'error', message: String(error) }
  }

  // Opportunistic WebSub discovery: the document is already in hand, so finding
  // `rel="hub"` costs nothing on the common path. Fire-and-forget — a hub that
  // is slow or down must never delay or fail an ingest.
  void ensureSubscribed(opts.handle, opts.feedId, feed.feedUrl, outcome.body, now).catch(() => {})

  const counts = sqlite.transaction(() => {
    let inserted = 0
    let updated = 0

    for (const item of parsed.items) {
      const existing = db
        .select()
        .from(entries)
        .where(and(eq(entries.feedId, feed.id), eq(entries.hash, item.hash)))
        .get()

      if (!existing) {
        const id = newEntryId(epochMs(now))
        db.insert(entries)
          .values({
            id,
            userId: feed.userId,
            feedId: feed.id,
            hash: item.hash,
            title: item.title,
            url: item.url,
            author: item.author,
            content: item.content,
            publishedAt: item.publishedAt,
            createdAt: epochMs(now),
            changedAt: epochMs(now),
            status: 'unread',
            starred: false,
            readingTime: estimateReadingTime(item.content),
            tags: item.tags,
          })
          .run()
        syncEntrySearch(sqlite, null, searchRowOf(sqlite, id))
        inserted++
        continue
      }

      // Soft-deleted rows win: a deleted entry never comes back.
      if (existing.status === 'removed') continue

      if (differs(existing, item)) {
        const before = searchRowOf(sqlite, existing.id)
        db.update(entries)
          .set({
            title: item.title,
            url: item.url,
            author: item.author,
            content: item.content,
            tags: item.tags,
            changedAt: epochMs(now),
            ...(existing.content !== item.content
              ? { readingTime: estimateReadingTime(item.content) }
              : {}),
          })
          .where(eq(entries.id, existing.id))
          .run()
        syncEntrySearch(sqlite, before, searchRowOf(sqlite, existing.id))
        updated++
      }
    }

    db.update(feeds)
      .set({
        checkedAt: outcome.fetchedAt,
        parsingErrorCount: 0,
        lastError: null,
        lastErrorAt: null,
        etagHeader: outcome.etag,
        lastModifiedHeader: outcome.lastModified,
      })
      .where(eq(feeds.id, feed.id))
      .run()

    return { inserted, updated }
  })()

  // Permanent move (301/308): update the stored URL. If another feed already
  // owns the target URL, the UNIQUE(user_id, feed_url) guard rejects it —
  // keep the old URL in that case.
  let moved = false
  if (outcome.permanentlyMoved && outcome.finalUrl !== feed.feedUrl) {
    try {
      db.update(feeds).set({ feedUrl: outcome.finalUrl }).where(eq(feeds.id, feed.id)).run()
      moved = true
    } catch {
      moved = false
    }
  }

  return {
    kind: 'ok',
    inserted: counts.inserted,
    updated: counts.updated,
    moved,
    iconUrl: parsed.iconUrl,
    siteUrl: parsed.siteUrl,
    freshnessMs: outcome.freshnessMs,
  }
}

/**
 * One full fetch-and-ingest cycle for a feed (the scheduler's call site):
 * conditional GET → ingest → icon fetch when the feed has none yet.
 */
export async function fetchAndIngest(opts: {
  handle: ReaderHandle
  feedId: FeedId
  now?: number
}): Promise<IngestResult> {
  const feed = opts.handle.db.select().from(feeds).where(eq(feeds.id, opts.feedId)).get()
  if (!feed) return { kind: 'error', message: `unknown feed ${opts.feedId}` }
  const outcome = await fetchFeed(feed.feedUrl, {
    etag: feed.etagHeader,
    lastModified: feed.lastModifiedHeader,
  })
  const result = ingestFeedOutcome({
    handle: opts.handle,
    feedId: opts.feedId,
    outcome,
    now: opts.now,
  })
  if (result.kind === 'ok') {
    const siteOrigin = safeOrigin(result.siteUrl ?? feed.siteUrl ?? feed.feedUrl)
    await ensureFeedIcon({
      handle: opts.handle,
      feedId: opts.feedId,
      candidates: [result.iconUrl, siteOrigin === null ? null : `${siteOrigin}/favicon.ico`].filter(
        (c): c is string => c !== null,
      ),
      now: opts.now,
    })
  }
  return result
}

function safeOrigin(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}
