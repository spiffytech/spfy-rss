/**
 * Stage 3 of the Miniflux import — the verification gate.
 *
 * Compares the frozen dump (source of truth) against the reader DB on natural
 * keys. The pass condition: zero problems, which includes a **verbatim diff of
 * the hash pairs (feed, hash) source-vs-import that comes back empty**.
 * Re-hashing stored rows is impossible (Miniflux never stores the raw guid);
 * recipe correctness is proven separately against MF's `testdata` fixtures.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ReaderHandle } from '../db'
import { categories, entries, feeds, icons, users } from '../db/schema'
import {
  mfCategory,
  mfEntry,
  mfFeed,
  mfIcon,
  mfTombstone,
  mfUser,
  normalizeStatus,
} from './mf-rows'

export type VerifyReport = {
  pass: boolean
  problems: string[]
  counts: { source: Record<string, number>; db: Record<string, number> }
  statusTotals: { source: Record<string, number>; db: Record<string, number> }
  starred: { source: number; db: number }
  publishedRangeNonRemoved: { source: [number, number] | null; db: [number, number] | null }
  hashDiff: { missingInDb: number; extraInDb: number }
  perFeedMismatches: { feedUrl: string; source: number; db: number }[]
}

function readRows<T>(dumpDir: string, table: string, schema: { parse(value: unknown): T }): T[] {
  const path = join(dumpDir, `${table}.jsonl`)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => schema.parse(JSON.parse(line)))
}

export function verifyImport(opts: { handle: ReaderHandle; dumpDir: string }): VerifyReport {
  const { db, sqlite } = opts.handle
  const problems: string[] = []

  // --- natural-key maps: MF row -> imported row ---
  const dbUsers = db.select().from(users).all()
  const userByName = new Map(dbUsers.map((u) => [u.username, u.id]))
  const dbFeeds = db.select().from(feeds).all()
  const mfFeedRows = readRows(opts.dumpDir, 'feeds', mfFeed)
  const feedByNatural = new Map<number, string>() // mf feed id -> our feed id
  // (users map needs MF rows too: username is the natural key)
  const mfUserRows = readRows(opts.dumpDir, 'users', mfUser)
  const ourUserByMf = new Map<number, string>()
  for (const row of mfUserRows) {
    const ours = userByName.get(row.username.toLowerCase())
    if (ours) ourUserByMf.set(row.id, ours)
    else problems.push(`user '${row.username}' missing in db`)
  }
  feedByNatural.clear()
  for (const row of mfFeedRows) {
    const userId = ourUserByMf.get(row.user_id)
    const ours = dbFeeds.find((f) => f.userId === userId && f.feedUrl === row.feed_url)
    if (ours) feedByNatural.set(row.id, ours.id)
    else problems.push(`feed '${row.feed_url}' missing in db`)
  }

  // --- source side ---
  const srcCounts = {
    users: mfUserRows.length,
    categories: readRows(opts.dumpDir, 'categories', mfCategory).length,
    feeds: mfFeedRows.length,
    entries: 0,
    stubs: 0,
    // icons dedupe on (mime, bytes) at load — byte-identical icons are one
    // row (Miniflux itself deduped on its hash column), so count unique pairs
    icons: new Set(
      readRows(opts.dumpDir, 'icons', mfIcon).map((r) => `${r.mime_type}\u0000${r.content.$bytes}`),
    ).size,
  }
  const srcStatus: Record<string, number> = { unread: 0, read: 0, removed: 0 }
  const srcHashPairs = new Set<string>()
  const srcPerFeed = new Map<string, number>() // our feed id -> count
  let srcStarred = 0
  let srcMin: number | null = null
  let srcMax: number | null = null

  for (const row of readRows(opts.dumpDir, 'entries', mfEntry)) {
    const feedId = feedByNatural.get(row.feed_id)
    if (!feedId) continue
    srcCounts.entries++
    const status = normalizeStatus(row.status)
    srcStatus[status] = (srcStatus[status] ?? 0) + 1
    srcHashPairs.add(`${feedId}\u0000${row.hash}`)
    srcPerFeed.set(feedId, (srcPerFeed.get(feedId) ?? 0) + 1)
    if (row.starred === true) srcStarred++
    if (status !== 'removed') {
      srcMin = srcMin === null ? row.published_at : Math.min(srcMin, row.published_at)
      srcMax = srcMax === null ? row.published_at : Math.max(srcMax, row.published_at)
    }
  }
  for (const row of readRows(opts.dumpDir, 'entry_tombstones', mfTombstone)) {
    const feedId = feedByNatural.get(row.feed_id)
    if (!feedId) continue
    srcCounts.stubs++
    srcStatus.removed = (srcStatus.removed ?? 0) + 1
    srcHashPairs.add(`${feedId}\u0000${row.hash}`)
    srcPerFeed.set(feedId, (srcPerFeed.get(feedId) ?? 0) + 1)
  }

  // --- db side ---
  const dbCounts = {
    users: db.select().from(users).all().length,
    categories: db.select().from(categories).all().length,
    feeds: dbFeeds.length,
    entries: 0,
    icons: db.select().from(icons).all().length,
  }
  const dbStatus: Record<string, number> = { unread: 0, read: 0, removed: 0 }
  const dbHashPairs = new Set<string>()
  const dbPerFeed = new Map<string, number>()
  let dbStarred = 0
  let dbMin: number | null = null
  let dbMax: number | null = null
  for (const row of db.select().from(entries).all()) {
    dbCounts.entries++
    dbStatus[row.status] = (dbStatus[row.status] ?? 0) + 1
    dbHashPairs.add(`${row.feedId}\u0000${row.hash}`)
    dbPerFeed.set(row.feedId, (dbPerFeed.get(row.feedId) ?? 0) + 1)
    if (row.starred) dbStarred++
    if (row.status !== 'removed') {
      dbMin = dbMin === null ? row.publishedAt : Math.min(dbMin, row.publishedAt)
      dbMax = dbMax === null ? row.publishedAt : Math.max(dbMax, row.publishedAt)
    }
  }

  // --- comparisons ---
  if (dbCounts.users !== srcCounts.users)
    problems.push(`users: source ${srcCounts.users} vs db ${dbCounts.users}`)
  if (dbCounts.categories !== srcCounts.categories)
    problems.push(`categories: source ${srcCounts.categories} vs db ${dbCounts.categories}`)
  if (dbCounts.feeds !== srcCounts.feeds)
    problems.push(`feeds: source ${srcCounts.feeds} vs db ${dbCounts.feeds}`)
  if (dbCounts.icons !== srcCounts.icons)
    problems.push(`icons: source ${srcCounts.icons} vs db ${dbCounts.icons}`)
  const expectedEntries = srcCounts.entries + srcCounts.stubs
  if (dbCounts.entries !== expectedEntries)
    problems.push(
      `entries: source ${expectedEntries} (incl. ${srcCounts.stubs} stubs) vs db ${dbCounts.entries}`,
    )
  for (const status of ['unread', 'read', 'removed'] as const) {
    if ((srcStatus[status] ?? 0) !== (dbStatus[status] ?? 0))
      problems.push(
        `status '${status}': source ${srcStatus[status] ?? 0} vs db ${dbStatus[status] ?? 0}`,
      )
  }
  if (srcStarred !== dbStarred) problems.push(`starred: source ${srcStarred} vs db ${dbStarred}`)
  const srcRangePair: [number, number] | null =
    srcMin === null || srcMax === null ? null : [srcMin, srcMax]
  const dbRangePair: [number, number] | null =
    dbMin === null || dbMax === null ? null : [dbMin, dbMax]
  if (JSON.stringify(srcRangePair) !== JSON.stringify(dbRangePair))
    problems.push(`published_at range (non-removed): source ${srcRangePair} vs db ${dbRangePair}`)

  const perFeedMismatches: VerifyReport['perFeedMismatches'] = []
  const feedUrlById = new Map<string, string | null>(
    dbFeeds.map((f) => [f.id as string, f.feedUrl]),
  )
  for (const [feedId, count] of srcPerFeed) {
    const dbCount = dbPerFeed.get(feedId) ?? 0
    if (dbCount !== count) {
      perFeedMismatches.push({
        feedUrl: feedUrlById.get(feedId) ?? feedId,
        source: count,
        db: dbCount,
      })
    }
  }
  if (perFeedMismatches.length)
    problems.push(`${perFeedMismatches.length} feed(s) with entry-count mismatches`)

  // the hash gate: exactly the pairs the plan demands, verbatim
  const missingInDb = [...srcHashPairs].filter((p) => !dbHashPairs.has(p))
  const extraInDb = [...dbHashPairs].filter((p) => !srcHashPairs.has(p))
  if (missingInDb.length)
    problems.push(`${missingInDb.length} (feed, hash) pair(s) present in source but missing in db`)
  if (extraInDb.length)
    problems.push(`${extraInDb.length} (feed, hash) pair(s) in db absent from source`)

  // Search index: `count(*) FROM entries_fts` reads the external-content
  // passthrough and proves nothing. integrity-check with rank=1 compares the
  // index against the content table and throws on any drift.
  try {
    sqlite.run(`INSERT INTO entries_fts(entries_fts, rank) VALUES('integrity-check', 1)`)
  } catch (e) {
    problems.push(`entries_fts index out of sync with entries: ${String(e).slice(0, 120)}`)
  }

  return {
    pass: problems.length === 0,
    problems,
    counts: { source: srcCounts, db: dbCounts },
    statusTotals: { source: srcStatus, db: dbStatus },
    starred: { source: srcStarred, db: dbStarred },
    publishedRangeNonRemoved: { source: srcRangePair, db: dbRangePair },
    hashDiff: { missingInDb: missingInDb.length, extraInDb: extraInDb.length },
    perFeedMismatches,
  }
}
