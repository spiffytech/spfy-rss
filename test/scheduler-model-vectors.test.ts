/**
 * The original scheduler model vectors, ported verbatim from the retired app's
 * src/server/lib/schedule/model.test.ts (same author, same design doc:
 * docs/feed-scheduler.md). They pin the behaviours the simulator validated and
 * the regressions that motivated the design — Miniflux's `(max-min)/(count-1)`
 * rate collapsing under clustering, the weekday gate turning a 65-items/day
 * feed into a once-a-day feed, the truncated-tail EMA understating a steady
 * rate, and `clamp(x, 3, 2)` polling a date-only feed MORE than its ceiling.
 *
 * One block is deliberately absent: `cache-hint decode` tested
 * `entryFrequencyIntervalMinutes` / `decodeCacheHintMinutes`, machinery that
 * existed only to recover a hint Miniflux had folded into `next_check_at`. This
 * app fetches feeds itself, so the hint is read directly from the response
 * (`Retry-After` / cache freshness) and persisted in `feeds.fetch_after_at` —
 * there is nothing to decode. See scheduler/model.ts's header.
 *
 * Only adaptation: `feedId` is a UUID string, not a Miniflux integer.
 */
import { describe, expect, test } from 'bun:test'

import type { FeedId } from '../src/shared/ids'
import {
  buildFeedModel,
  MINUTES_PER_DAY,
  minuteOfDay,
  nextPollInstant,
  resolveTarget,
  type FeedInput,
  type ScheduleOptions,
} from '../src/server/scheduler/model'

const OPTS: ScheduleOptions = {
  entryFrequencyFactor: 1,
  maxPollsPerDay: 288,
  learningWindowDays: 90,
  rateHalfLifeDays: 7,
  nowEpochDay: 19089,
}

/** `days` consecutive epoch days starting at 19000. */
const day = (i: number) => 19000 + i

function feed(stamps: number[], dayCounts: Map<number, number>): FeedInput {
  return { feedId: 'feed-1' as FeedId, stamps, dayCounts }
}

describe('buildFeedModel', () => {
  test('punctual daily feed: two polls, inside the bell and past the tail', () => {
    const stamps: number[] = []
    const dayCounts = new Map<number, number>()
    for (let i = 0; i < 90; i++) {
      stamps.push(21 * 60) // 21:00 UTC every day
      dayCounts.set(day(i), 1)
    }
    const m = buildFeedModel(feed(stamps, dayCounts), OPTS)
    expect(m).not.toBeNull()
    // 90 entries over 7 weekdays => no weekday signal, so the budget collapses
    // to the item rate -- and the FLOOR of 2, because a day we expect a
    // delivery needs a pair: one inside the bell, one past the tail. That pair
    // is what catches a delivery that drifts late.
    for (let d = 0; d < 7; d++) expect(m!.budget[d]).toBe(2)
    const polls = m!.pollMinutes(3)
    expect(polls).toHaveLength(2)
    // one at the mode, one 20min past the observed tail
    expect(polls).toEqual([21 * 60, 21 * 60 + 20])
  })

  test('bimodal feed: two modes are recognised', () => {
    const stamps: number[] = []
    const dayCounts = new Map<number, number>()
    for (let i = 0; i < 60; i++) {
      stamps.push(i % 2 === 0 ? 9 * 60 : 21 * 60)
      dayCounts.set(day(i), 1)
    }
    const m = buildFeedModel(feed(stamps, dayCounts), OPTS)
    expect(m).not.toBeNull()
    expect(m!.concentrated).toBe(true)
    expect(m!.numModes).toBeGreaterThanOrEqual(2)
  })

  test('two entries five minutes apart yield TWO polls, not 288', () => {
    // The exact shape that made Miniflux poll Framework Blog every 5 minutes.
    // The budget floor is 2, never the entry count.
    const dayCounts = new Map<number, number>([[day(0), 2]])
    const m = buildFeedModel(feed([20 * 60, 20 * 60 + 5], dayCounts), OPTS)
    expect(m).not.toBeNull()
    for (let d = 0; d < 7; d++) expect(m!.budget[d]).toBe(2)
  })

  test('clustering cannot inflate the budget', () => {
    // 20 entries in a five-minute burst on one day of a 90-day window.
    const stamps = Array.from({ length: 20 }, (_, i) => 20 * 60 + i)
    const dayCounts = new Map<number, number>([[day(0), 20]])
    const m = buildFeedModel(feed(stamps, dayCounts), OPTS)
    expect(m).not.toBeNull()
    for (let d = 0; d < 7; d++) expect(m!.budget[d]).toBeLessThanOrEqual(2)
  })

  test('date-only feed: uniform placement with a floor of three', () => {
    const stamps = Array.from({ length: 30 }, () => 0) // every entry stamped midnight
    const dayCounts = new Map<number, number>()
    for (let i = 0; i < 30; i++) dayCounts.set(day(i), 1)
    const m = buildFeedModel(feed(stamps, dayCounts), OPTS)
    expect(m).not.toBeNull()
    expect(m!.dateOnly).toBe(true)
    for (let d = 0; d < 7; d++) expect(m!.budget[d]).toBeGreaterThanOrEqual(3)
    expect(m!.pollMinutes(3)).toEqual([240, 720, 1200])
  })

  test('weekday signal concentrates the budget on publish days', () => {
    // Publishes only on Tuesdays (epoch days 19000..: 19000 % 7 === 3, so use a
    // step of 7 to keep the weekday fixed).
    const stamps: number[] = []
    const dayCounts = new Map<number, number>()
    for (let i = 0; i < 13; i++) {
      stamps.push(10 * 60)
      dayCounts.set(day(i * 7), 1)
    }
    const m = buildFeedModel(feed(stamps, dayCounts), OPTS)
    expect(m).not.toBeNull()
    expect(m!.dowSignal).toBe(true)
    const publishDow = new Date(19000 * 86400_000).getUTCDay()
    // Publish day: the delivery pair (inside the bell + past the tail).
    expect(m!.budget[publishDow]).toBe(2)
    // Non-publish days fall back to the 1/day floor rather than being starved.
    for (let d = 0; d < 7; d++) {
      if (d !== publishDow) expect(m!.budget[d]).toBe(1)
    }
  })

  test('a feed that posts every day keeps its full budget on every day', () => {
    // Regression: the weekday gate used a fixed 0.12 share, and a daily feed
    // sits at ~1/7 = 0.143 per weekday. Sampling noise that dropped one weekday
    // below 0.12 flipped dowSignal on and gave that weekday a budget of 1,
    // turning Hacker News (65 items/day) into a once-a-day feed.
    const stamps: number[] = []
    const dayCounts = new Map<number, number>()
    let n = 0
    for (let i = 0; i < 90; i++) {
      // 63 items/day, but deliberately uneven across weekdays (one weekday gets
      // only 8 active days out of 90).
      const dow = new Date(day(i) * 86400_000).getUTCDay()
      // Wednesday is merely uneven (about 10 active days out of 90), not absent.
      if (dow === 3 && i % 4 === 0) continue
      const items = 63
      for (let k = 0; k < items; k++) stamps.push(Math.floor((k * MINUTES_PER_DAY) / items))
      dayCounts.set(day(i), items)
      n += items
    }
    expect(n).toBeGreaterThan(4000)
    const m = buildFeedModel(feed(stamps, dayCounts), OPTS)
    expect(m).not.toBeNull()
    expect(m!.dowSignal).toBe(false)
    for (let d = 0; d < 7; d++) expect(m!.budget[d]).toBeGreaterThanOrEqual(50)
  })

  test('no entries yields no model', () => {
    expect(buildFeedModel(feed([], new Map()), OPTS)).toBeNull()
  })
})

describe('rate EMA', () => {
  test('follows a feed that accelerates — a flat window average could not', () => {
    // Quiet at 4/day for 80 days, then 30/day for the last 10.
    const dayCounts = new Map<number, number>()
    for (let i = 0; i < 80; i++) dayCounts.set(day(i), 4)
    for (let i = 80; i < 90; i++) dayCounts.set(day(i), 30)
    const stamps = new Array<number>(620).fill(12 * 60)
    const m = buildFeedModel(feed(stamps, dayCounts), OPTS)
    expect(m).not.toBeNull()
    // Flat average would be (80*4 + 10*30)/90 = 6.2/day. The EMA is dominated by
    // the recent 30/day and lands near 20 — the budget has to follow the pace
    // or the items published today sit unread for hours.
    expect(m!.budget[0]).toBeGreaterThan(15)
  })

  test('clustering cannot inflate the rate (the mean-gap pathology)', () => {
    // Two entries five minutes apart on ONE day. Miniflux's
    // (max-min)/(count-1) denominator collapses and yields 288 items/day.
    const dayCounts = new Map<number, number>([[day(89), 2]])
    const m = buildFeedModel(feed([600, 605], dayCounts), OPTS)
    expect(m).not.toBeNull()
    expect(Math.max(...m!.budget)).toBeLessThanOrEqual(3)
  })

  test('a steady feed reports exactly its rate, for any half-life', () => {
    // Guards the truncated-tail normalisation: without it a constant rate r
    // reads as r*(1 - decay^learnDays) and silently understates the budget.
    const dayCounts = new Map<number, number>()
    for (let i = 0; i < 90; i++) dayCounts.set(day(i), 20)
    const stamps = new Array<number>(1800).fill(12 * 60)
    for (const hl of [1, 3, 7, 30, 200]) {
      const m = buildFeedModel(feed(stamps, dayCounts), { ...OPTS, rateHalfLifeDays: hl })
      expect(m).not.toBeNull()
      expect(m!.budget[0]).toBe(20)
    }
  })

  test('a feed that goes quiet decays back to the floor', () => {
    const dayCounts = new Map<number, number>()
    for (let i = 0; i < 30; i++) dayCounts.set(day(i), 40) // busy month…
    // …then nothing for the last 60 days
    const stamps = new Array<number>(1200).fill(12 * 60)
    const m = buildFeedModel(feed(stamps, dayCounts), OPTS)
    expect(m).not.toBeNull()
    // The floor is 2 while the feed is still active on any day at all: a
    // stalled feed errs toward noticing recovery.
    expect(m!.budget[0]).toBe(2)
  })
})

describe('regressions', () => {
  test('minuteOfDay stays in 0..1439 for pre-1970 timestamps', () => {
    // JS `%` keeps the sign of the dividend, so a naive implementation returns
    // -1 here and silently breaks the 0..1439 contract.
    const justBeforeEpoch = Date.UTC(1969, 11, 31, 23, 59, 30)
    expect(minuteOfDay(justBeforeEpoch)).toBe(1439)
    expect(minuteOfDay(-1)).toBe(1439)
    for (const ms of [-1, -60_000, -86_400_000, -123_456_789]) {
      const m = minuteOfDay(ms)
      expect(m).toBeGreaterThanOrEqual(0)
      expect(m).toBeLessThan(MINUTES_PER_DAY)
    }
  })

  test('date-only budget never exceeds maxPollsPerDay, even when it is below 3', () => {
    // clamp(x, 3, 2) used to return 3 and poll MORE than the configured max.
    const stamps = new Array<number>(30).fill(0) // date-only: all midnight
    const dayCounts = new Map<number, number>()
    for (let i = 0; i < 30; i++) dayCounts.set(day(i), 1)
    const opts: ScheduleOptions = { ...OPTS, maxPollsPerDay: 2 }
    const m = buildFeedModel(feed(stamps, dayCounts), opts)
    expect(m).not.toBeNull()
    expect(m!.dateOnly).toBe(true)
    for (let d = 0; d < 7; d++) expect(m!.budget[d]).toBeLessThanOrEqual(2)
  })
})

describe('a committed target is never postponed', () => {
  test('a pending retry survives the next tick instead of being clobbered', () => {
    // The retry chain is written on the tick where checked_at advances. The
    // next tick recomputes the strictly-future bell and used to rewrite over
    // it, so a 5-30min retry never fired against a bell hours away.
    const retry = 1000
    const nextBell = 1000 + 3 * 60 * 60 * 1000
    expect(resolveTarget(nextBell, retry, false)).toBe(retry)
  })

  test('an overdue target stays overdue instead of sliding to the next bell', () => {
    // A target that expired before the fetch batch consumed it must remain
    // due now, not be raised to a future bell ("never due at all").
    const overdue = 1000
    const nextBell = 1000 + 3 * 60 * 60 * 1000
    expect(resolveTarget(nextBell, overdue, false)).toBe(overdue)
    expect(resolveTarget(nextBell, overdue, false)).toBeLessThan(Date.now())
  })

  test('right after a fetch, the fresh plan replaces the committed target', () => {
    // On that tick `currentNext` is the stale commitment, not a real plan —
    // keeping it would pin a sparse feed to its old rate.
    const staleCommitment = 1000 + 25 * 60 * 1000
    const ourBell = 1000 + 6 * 60 * 60 * 1000
    expect(resolveTarget(ourBell, staleCommitment, true)).toBe(ourBell)
  })

  test('a Retry-After floor is allowed to raise a target', () => {
    // The origin asking us to wait is the one thing that may override the
    // never-postpone rule.
    expect(resolveTarget(1000, 500, false, 5000)).toBe(5000)
  })
})

describe('errors never throttle a learned schedule', () => {
  test('a flaky feed keeps every one of its bells', () => {
    // This is the whole policy. Errors were tried as a hard probe, a per-feed
    // cap and a per-host cap; all three were net-harmful. The only feed we could
    // measure (hnrss.org, HTTP 502 waves) still delivered 56 items/day, and
    // throttling it to 3 polls/day produced a 277-minute median. A 502 is the
    // server failing, not the server asking us to slow down.
    const stamps: number[] = []
    const dayCounts = new Map<number, number>()
    for (let i = 0; i < 90; i++) {
      for (let k = 0; k < 40; k++) stamps.push(Math.floor((k * MINUTES_PER_DAY) / 40))
      dayCounts.set(day(i), 40)
    }
    const m = buildFeedModel(feed(stamps, dayCounts), OPTS)!
    const dayStart = 19089 * 86_400_000
    const learned = m.pollMinutes(new Date(dayStart).getUTCDay())
    expect(learned.length).toBe(40)

    const collected: number[] = []
    let cursor = dayStart - 1
    const end = dayStart + MINUTES_PER_DAY * 60_000
    for (let i = 0; i < 500; i++) {
      const n = nextPollInstant(m, cursor)
      if (!n || n.getTime() >= end) break
      collected.push(n.getTime())
      cursor = n.getTime()
    }
    // Every bell survives regardless of parsing_error_count -- errors are not
    // an input to nextPollInstant at all.
    expect(collected.length).toBe(40)
  })
})
