/**
 * SQLite access for the scheduler. Ported from the retired app's Postgres
 * layer (src/server/lib/schedule/db.ts); same shape, three deltas:
 *
 * - `next_check_at` is a plain epoch-ms integer, so the compare-and-swap anchor
 *   is exact — the old `checked_at::text` microsecond workaround is gone.
 * - Learning aggregates come from one ordered scan computed in JS. SQLite is
 *   the local filesystem here, so pulling `(feed_id, published_at)` costs
 *   nothing and the median gap no longer needs `percentile_cont`.
 * - The advisory lock is gone: one process owns the DB (see scheduler/index.ts).
 */
import { and, eq, isNull } from 'drizzle-orm'

import type { EpochMs, FeedId } from '../../shared/ids'
import type { ReaderHandle } from '../db'
import { entries, feeds } from '../db/schema'
import type { FeedScheduleState } from './model'
import { minuteOfDay, epochDay } from './model'

/** Entries before this instant never teach anything (import sentinel rows). */
const SENTINEL_MS = Date.UTC(2000, 0, 1)
const MS_PER_DAY = 86_400_000

export interface LearnAggregates {
  /** feedId -> (UTC epoch day -> entry count) */
  dayCounts: Map<FeedId, Map<number, number>>
  /** feedId -> (minute-of-day -> entry count) */
  minuteCounts: Map<FeedId, Map<number, number>>
  /** feedId -> median gap between consecutive published_at, in minutes */
}

/**
 * Every feed's scheduling state. Eligibility (POLLING_PARSING_ERROR_LIMIT)
 * is applied by the runner, not here — the schedule pass still plans feeds
 * that are not fetchable, so a later limit change re-engages them cleanly.
 */
export function fetchScheduleFeeds(db: ReaderHandle['db']): FeedScheduleState[] {
  return db
    .select({
      id: feeds.id,
      url: feeds.feedUrl,
      checkedAt: feeds.checkedAt,
      nextCheckAt: feeds.nextCheckAt,
      parsingErrorCount: feeds.parsingErrorCount,
    })
    .from(feeds)
    .all()
}

/** Learning aggregates over the window: published_at only, sentinel dropped,
 *  removed rows never teach. */
export function fetchLearnAggregates(
  sqlite: ReaderHandle['sqlite'],
  learningWindowDays: number,
  nowMs: number,
): LearnAggregates {
  const since = nowMs - learningWindowDays * MS_PER_DAY
  const rows = sqlite
    .query<{ feed_id: string; published_at: number }, [number, number]>(
      `SELECT feed_id, published_at FROM entries
        WHERE published_at > ? AND published_at > ? AND status <> 'removed'
        ORDER BY feed_id, published_at`,
    )
    .all(since, SENTINEL_MS)

  const dayCounts = new Map<FeedId, Map<number, number>>()
  const minuteCounts = new Map<FeedId, Map<number, number>>()
  let cur: FeedId | null = null
  for (const row of rows) {
    const feedId = row.feed_id as FeedId
    if (feedId !== cur) cur = feedId
    const t = row.published_at
    let days = dayCounts.get(feedId)
    if (!days) dayCounts.set(feedId, (days = new Map()))
    const day = epochDay(t)
    days.set(day, (days.get(day) ?? 0) + 1)
    let mins = minuteCounts.get(feedId)
    if (!mins) minuteCounts.set(feedId, (mins = new Map()))
    const m = minuteOfDay(t)
    mins.set(m, (mins.get(m) ?? 0) + 1)
  }
  return { dayCounts, minuteCounts }
}

export interface TargetWrite {
  id: FeedId
  target: EpochMs
  /** The checked_at value read this cycle — the CAS anchor. */
  expectedCheckedAt: EpochMs | null
}

/**
 * Compare-and-swap each target, one transaction per cycle. Matching on
 * checked_at means a feed that moved underneath us (a fetch landed between
 * plan and write) is simply recomputed next cycle instead of being clobbered.
 * `IS NOT DISTINCT FROM` semantics: a NULL checked_at matches only NULL.
 */
export function applyTargets(db: ReaderHandle['db'], writes: TargetWrite[]): Set<FeedId> {
  const done = new Set<FeedId>()
  if (writes.length === 0) return done
  db.transaction(() => {
    for (const w of writes) {
      const rows = db
        .update(feeds)
        .set({ nextCheckAt: w.target })
        .where(
          and(
            eq(feeds.id, w.id),
            w.expectedCheckedAt === null
              ? isNull(feeds.checkedAt)
              : eq(feeds.checkedAt, w.expectedCheckedAt),
          ),
        )
        .returning({ id: feeds.id })
        .all()
      if (rows.length > 0) done.add(w.id)
    }
  })
  return done
}

export { SENTINEL_MS }
