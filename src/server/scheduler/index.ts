/**
 * The scheduler: decide when each feed is fetched, then fetch it.
 *
 * Ported from the retired app's supervisor (src/server/lib/schedule/index.ts)
 * whose job was to assert `feeds.next_check_at` at Miniflux, the actual fetcher.
 * Here we own both sides, so three things dissolve and everything else stands:
 *
 * - No cache-hint DECODE (the `prev`/`hints` maps, `checked_at`-advanced
 *   archaeology, `entryFrequencyIntervalMinutes`). The fetcher reads
 *   `Retry-After` / cache freshness itself and persists the floor in
 *   `feeds.fetch_after_at` — authorship is a fact, not an inference (the old
 *   code carried a TODO asking for exactly this). It also closes the old doc's
 *   "short cache hints are unrecoverable" limitation.
 * - No advisory lock: one process owns the SQLite file.
 * - The compare-and-swap on `checked_at` survives (cheap insurance against a
 *   dev instance sharing a DB) but never blocks anything here.
 *
 * Everything behavioural ports verbatim: learned bells and budgets, the
 * staleness ceiling with per-feed jitter, probe backoff on the unmodelled path
 * only, and "a committed target is replaced only by an earlier one" (the
 * origin's floor is the one thing allowed to push back).
 */
import { eq } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { FeedId } from '../../shared/ids'
import { epochMs } from '../../shared/ids'
import type { ReaderHandle } from '../db'
import { appDb, appDbPath } from '../db-app'
import { fetchAndIngest } from '../fetch/fetch-feed'
import { feeds } from '../db/schema'
import type { SchedulerConfig } from './config'
import { loadSchedulerConfig } from './config'
import { applyTargets, fetchLearnAggregates, fetchScheduleFeeds, type TargetWrite } from './db'
import { lastTickAgeMinutes, markSchedulerStarted, markTick } from './heartbeat'
import {
  buildFeedModel,
  epochDay,
  expandMinuteCounts,
  planTarget,
  RETRY_REACH_MINUTES,
  RETRY_STEP_MINUTES,
  MAX_RETRIES,
  type FeedInput,
  type FeedModel,
  type FeedScheduleState,
} from './model'
import { notify } from './notify'
import { renewDue } from '../websub'

/**
 * Runtime kill switch, same operational contract as the old app: touching this
 * file pauses fetching and scheduling without a redeploy. Removing it resumes.
 */
const OFF_FLAG = () => join(dirname(appDbPath()), '.scheduler-off')

const TICK_MS = 60_000
/** The learned model only moves when new entries land; rebuilding every tick
 *  would re-aggregate the whole window 1440 times a day for nothing. */
const REBUILD_MS = 15 * 60_000
/** Ignore sub-minute churn so we are not rewriting next_check_at constantly. */
const TOLERANCE_MS = 60_000
/** A hung scheduling pass must not kill the loop (see withTimeout). */
const TICK_TIMEOUT_MS = 120_000
/** Fetches dispatched per tick — the boot backlog drains at this rate. */
const FETCH_BATCH_PER_TICK = 12
/** Parallel fetches; no two in flight share a host. */
const FETCH_CONCURRENCY = 4

interface ModelCache {
  builtAt: number
  models: Map<FeedId, FeedModel>
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} after ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

function toInputs(agg: ReturnType<typeof fetchLearnAggregates>): Map<FeedId, FeedInput> {
  const out = new Map<FeedId, FeedInput>()
  for (const [feedId, dayCounts] of agg.dayCounts) {
    out.set(feedId, {
      feedId,
      stamps: expandMinuteCounts(agg.minuteCounts.get(feedId) ?? new Map()),
      dayCounts,
    })
  }
  return out
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/**
 * Start the loop. Returns a stop function, or null when disabled. A thrown
 * error inside the loop is caught and reported rather than allowed to kill the
 * process: a dead scheduler means feeds silently never update again.
 */
export function startScheduler(opts?: {
  handle?: ReaderHandle
  config?: SchedulerConfig
}): (() => void) | null {
  const config = opts?.config ?? loadSchedulerConfig()
  if (!config.enabled) {
    console.warn('scheduler: SCHEDULER_ENABLED=0; feeds are not polled')
    return null
  }
  const handle = opts?.handle ?? appDb()
  const bounds = {
    minIntervalMinutes: config.minIntervalMinutes,
    maxIntervalMinutes: config.maxIntervalMinutes,
    failingFeedMaxIntervalMinutes: config.failingFeedMaxIntervalMinutes,
    entryFrequencyFactor: config.entryFrequencyFactor,
    maxPollsPerDay: config.maxPollsPerDay,
    learningWindowDays: config.learningWindowDays,
    rateHalfLifeDays: config.rateHalfLifeDays,
  }

  let models: ModelCache | null = null
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let reportedOff = false
  const inFlight = new Set<FeedId>()
  const hostsInFlight = new Set<string>()
  /** Retries remaining per feed while an expected delivery has not arrived. */
  const retryState = new Map<FeedId, number>()
  /** Last WebSub lease sweep. Leases run 8 days and renew at 2 left. */
  let lastWebsubRenewAt = 0

  markSchedulerStarted()
  void notify(config.ntfyUrl, 'reader scheduler started', `pid ${process.pid}`)

  /** One fetch completion: record the origin's floor, then replan freely.
   *
   *  `inserted` is what the fetch actually brought back — null when we cannot
   *  tell (transport error, rate limit). This is the signal retry-until-delivery
   *  runs on: inside the learned delivery window, an empty fetch means the
   *  delivery is LATE, not absent, so look again shortly rather than tomorrow. */
  const afterFetch = (
    feed: FeedScheduleState,
    floorMs: number | null,
    inserted: number | null,
  ): void => {
    try {
      handle.db
        .update(feeds)
        .set({ fetchAfterAt: floorMs === null ? null : epochMs(floorMs) })
        .where(eq(feeds.id, feed.id))
        .run()
      const row = handle.db.select().from(feeds).where(eq(feeds.id, feed.id)).get()
      if (!row) return
      const model = models?.models.get(feed.id) ?? null

      // A delivery landed: the chain is done, plan the next bell.
      if (inserted === null || inserted > 0) retryState.delete(feed.id)

      const nowMs = Date.now()
      let retryTarget: number | null = null
      if (model && inserted === 0) {
        // Only on days the model EXPECTS a delivery. A weekend with no comic
        // due must not burn a retry chain on an empty feed.
        const dow = new Date(nowMs).getUTCDay()
        const expectingDelivery = (model.budget[dow] ?? 1) >= 2
        const nowMin = (nowMs / 60_000) % 1440
        const intoWindow =
          (nowMin - model.deliveryStartMinute + 1440) % 1440 <=
          model.deliverySpanMinute + RETRY_REACH_MINUTES
        if (expectingDelivery && intoWindow) {
          const left =
            retryState.get(feed.id) ??
            Math.min(
              MAX_RETRIES,
              Math.ceil((model.deliverySpanMinute + RETRY_REACH_MINUTES) / RETRY_STEP_MINUTES),
            )
          if (left > 0) {
            retryState.set(feed.id, left - 1)
            // Anchored on checkedAt: `now + X` chases the clock and never comes due.
            retryTarget = (row.checkedAt ?? nowMs) + RETRY_STEP_MINUTES * 60_000
          }
        }
      }

      const target =
        retryTarget ??
        planTarget(
          {
            id: row.id,
            url: row.feedUrl,
            checkedAt: row.checkedAt,
            nextCheckAt: row.nextCheckAt,
            parsingErrorCount: row.parsingErrorCount,
          },
          model,
          bounds,
          { nowMs, justFetched: true },
        )
      applyTargets(handle.db, [
        { id: feed.id, target: epochMs(target), expectedCheckedAt: row.checkedAt },
      ])
    } catch (e) {
      console.error('scheduler: post-fetch plan failed', e)
    }
  }

  const dispatchFetch = (feed: FeedScheduleState): void => {
    inFlight.add(feed.id)
    const host = hostOf(feed.url)
    hostsInFlight.add(host)
    void (async () => {
      let floorMs: number | null = null
      // null = we cannot tell whether anything arrived (transport error, 429).
      let inserted: number | null = null
      try {
        const result = await fetchAndIngest({ handle, feedId: feed.id })
        const hint =
          result.kind === 'rate-limited'
            ? result.retryAfterMs
            : result.kind === 'ok' || result.kind === 'not-modified'
              ? result.freshnessMs
              : null
        if (hint != null) floorMs = Date.now() + hint
        if (result.kind === 'ok') inserted = result.inserted
        else if (result.kind === 'not-modified') inserted = 0
      } catch (e) {
        console.error('scheduler: fetch failed', feed.id, e)
      } finally {
        inFlight.delete(feed.id)
        hostsInFlight.delete(host)
      }
      afterFetch(feed, floorMs, inserted)
    })()
  }

  const tick = (): void => {
    const now = Date.now()
    const all = fetchScheduleFeeds(handle.db)

    if (!models || now - models.builtAt > REBUILD_MS) {
      const agg = fetchLearnAggregates(handle.sqlite, config.learningWindowDays, now)
      const inputs = toInputs(agg)
      const built = new Map<FeedId, FeedModel>()
      for (const [feedId, input] of inputs) {
        const model = buildFeedModel(input, {
          entryFrequencyFactor: config.entryFrequencyFactor,
          maxPollsPerDay: config.maxPollsPerDay,
          learningWindowDays: config.learningWindowDays,
          rateHalfLifeDays: config.rateHalfLifeDays,
          nowEpochDay: epochDay(now),
        })
        if (model) built.set(feedId, model)
      }
      models = { builtAt: now, models: built }
    }

    // WebSub lease renewal, at most hourly. Housekeeping only: a sweep that
    // never runs just lapses the subscriptions back to polling.
    if (now - lastWebsubRenewAt > 60 * 60_000) {
      lastWebsubRenewAt = now
      void renewDue(handle, now)
        .then(({ renewed, failed }) => {
          // Quiet when there was nothing due; loud enough that `uc logs` can
          // answer "are subscriptions still being renewed?".
          if (renewed > 0 || failed > 0) {
            console.log(`websub: renew sweep renewed=${renewed} failed=${failed}`)
          }
        })
        .catch((error) => console.error('websub: renew sweep failed', error))
    }

    // Fetch pass first: `next_check_at IS NULL` means due, and a fetch that
    // lands during this tick replans its own feed (justFetched) afterwards.
    const eligible = all.filter(
      (f) =>
        !inFlight.has(f.id) &&
        (config.parsingErrorLimit === 0 || f.parsingErrorCount < config.parsingErrorLimit) &&
        (f.nextCheckAt === null || f.nextCheckAt <= now),
    )
    eligible.sort((a, b) => (a.nextCheckAt ?? 0) - (b.nextCheckAt ?? 0))
    const queue = eligible.slice(0, FETCH_BATCH_PER_TICK)
    const running = () => inFlight.size
    const startReady = (): void => {
      for (const feed of [...queue]) {
        if (running() >= FETCH_CONCURRENCY) return
        if (hostsInFlight.has(hostOf(feed.url))) continue
        queue.splice(queue.indexOf(feed), 1)
        dispatchFetch(feed)
      }
    }
    startReady()
    // Feeds held back by the per-host rule get their chance as hosts free up.
    if (queue.length > 0) {
      const pump = setInterval(() => {
        if (stopped || queue.length === 0) {
          clearInterval(pump)
          return
        }
        startReady()
      }, 1_000)
    }

    // Schedule pass: everything not in flight gets its plan. In-flight feeds
    // are replanned by afterFetch on completion.
    const writes: TargetWrite[] = []
    for (const feed of all) {
      if (inFlight.has(feed.id)) continue
      const targetMs = planTarget(feed, models.models.get(feed.id) ?? null, bounds, {
        nowMs: now,
        justFetched: false,
      })
      if (feed.nextCheckAt != null && Math.abs(targetMs - feed.nextCheckAt) <= TOLERANCE_MS)
        continue
      writes.push({
        id: feed.id,
        target: epochMs(targetMs),
        expectedCheckedAt: feed.checkedAt === null ? null : epochMs(feed.checkedAt),
      })
    }
    applyTargets(handle.db, writes)
  }

  const run = async (): Promise<void> => {
    if (existsSync(OFF_FLAG())) {
      if (!reportedOff) {
        reportedOff = true
        console.warn(`scheduler: disabled via ${OFF_FLAG()}; feeds are not polled`)
        void notify(
          config.ntfyUrl,
          'reader scheduler disabled',
          `off-flag present at ${OFF_FLAG()}`,
        )
      }
      markTick(true)
      if (!stopped) timer = setTimeout(run, TICK_MS)
      return
    }
    if (reportedOff) {
      reportedOff = false
      void notify(config.ntfyUrl, 'reader scheduler resumed', 'off-flag removed')
    }
    const gap = lastTickAgeMinutes()
    if (gap != null && gap > config.maxTickAgeMinutes) {
      void notify(config.ntfyUrl, 'reader scheduler gap', `resumed after ${gap.toFixed(0)} minutes`)
    }
    try {
      await withTimeout(Promise.resolve().then(tick), TICK_TIMEOUT_MS, 'scheduler tick timed out')
      markTick(true)
    } catch (e) {
      console.error('scheduler: tick failed', e)
      markTick(false, String(e))
      void notify(config.ntfyUrl, 'reader scheduler tick failed', String(e))
    }
    if (!stopped) timer = setTimeout(run, TICK_MS)
  }
  void run()

  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
