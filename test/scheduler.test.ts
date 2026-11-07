import { describe, expect, test } from 'bun:test'

import type { FeedId } from '../src/shared/ids'
import {
  buildFeedModel,
  emaDailyCount,
  epochDay,
  expandMinuteCounts,
  minuteOfDay,
  planTarget,
  probeIntervalMinutes,
  resolveTarget,
  stableJitter,
  type FeedInput,
  type FeedModel,
  type PlanBounds,
} from '../src/server/scheduler/model'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0) // Thursday, noon UTC
const TODAY = epochDay(NOW)

const bounds: PlanBounds = {
  minIntervalMinutes: 5,
  maxIntervalMinutes: 1440,
  failingFeedMaxIntervalMinutes: 10080,
  entryFrequencyFactor: 1,
  maxPollsPerDay: 288,
  learningWindowDays: 90,
  rateHalfLifeDays: 7,
}

const FID = 'feed-a' as FeedId

function input(over: Partial<FeedInput> = {}): FeedInput {
  return { feedId: FID, stamps: [], dayCounts: new Map(), ...over }
}

function steady(stampsPerDay: number, days = 90): FeedInput {
  const dayCounts = new Map<number, number>()
  const stamps: number[] = []
  for (let k = 0; k < days; k++) {
    dayCounts.set(TODAY - k, stampsPerDay)
    for (let i = 0; i < stampsPerDay; i++) stamps.push(8 * 60) // 08:00 UTC
  }
  return input({ stamps, dayCounts })
}

function modelOf(inp: FeedInput): FeedModel {
  const m = buildFeedModel(inp, {
    entryFrequencyFactor: bounds.entryFrequencyFactor,
    maxPollsPerDay: bounds.maxPollsPerDay,
    learningWindowDays: bounds.learningWindowDays,
    rateHalfLifeDays: bounds.rateHalfLifeDays,
    nowEpochDay: TODAY,
  })
  if (!m) throw new Error('expected a model')
  return m
}

describe('item-rate EMA', () => {
  test('a steady feed reports exactly its rate at any half-life (tail normalisation)', () => {
    const dayCounts = new Map<number, number>()
    for (let k = 0; k < 90; k++) dayCounts.set(TODAY - k, 4)
    expect(emaDailyCount(dayCounts, TODAY, 7, 90)).toBeCloseTo(4, 6)
    expect(emaDailyCount(dayCounts, TODAY, 1, 90)).toBeCloseTo(4, 6)
    expect(emaDailyCount(dayCounts, TODAY, 30, 90)).toBeCloseTo(4, 6)
  })

  test('a feed that accelerates is followed within a few half-lives', () => {
    const dayCounts = new Map<number, number>()
    for (let k = 0; k < 90; k++) dayCounts.set(TODAY - k, k < 5 ? 30 : 4)
    // 5 days at 30/day after a long 4/day history: well above the old rate.
    expect(emaDailyCount(dayCounts, TODAY, 7, 90)).toBeGreaterThan(8)
  })
})

describe('budget', () => {
  test('the floor never exceeds the ceiling (date-only feed, tight ceiling)', () => {
    const inp = input({ stamps: [0, 0, 0], dayCounts: new Map([[TODAY, 3]]) })
    const m = buildFeedModel(inp, {
      entryFrequencyFactor: 1,
      maxPollsPerDay: 2, // clamp(x, 3, 2) must not return 3
      learningWindowDays: 90,
      rateHalfLifeDays: 7,
      nowEpochDay: TODAY,
    })
    expect(m).not.toBeNull()
    for (const b of m!.budget) expect(b).toBeLessThanOrEqual(2)
  })

  test('one burst day cannot invent a weekday commitment', () => {
    // 20 entries on a single Tuesday: activeDays = 1 < 12 -> no weekday gate,
    // and budget is identical across weekdays.
    const inp = input({
      stamps: Array.from({ length: 20 }, (_, i) => 9 * 60 + i),
      dayCounts: new Map([[TODAY, 20]]),
    })
    const m = modelOf(inp)
    expect(m.dowSignal).toBe(false)
    expect(new Set(m.budget).size).toBe(1)
  })

  test('date-only feeds poll uniformly; one-poll feeds use the 85th percentile', () => {
    const uniform = modelOf(input({ stamps: [0, 0, 0], dayCounts: new Map([[TODAY, 3]]) }))
    expect(uniform.dateOnly).toBe(true)
    expect(uniform.pollMinutes(4)).toEqual([240, 720, 1200])
  })
})

describe('target resolution', () => {
  const t = (min: number) => NOW + min * 60_000

  test('a committed target is replaced only by an earlier one', () => {
    // Committed +30m; a later candidate (+2h) must not postpone it…
    expect(resolveTarget(t(120), t(30), false)).toBe(t(30))
    // …but an earlier one (retry chain) replaces it.
    expect(resolveTarget(t(10), t(30), false)).toBe(t(10))
  })

  test('justFetched replaces freely (the fresh plan is not a stale commitment)', () => {
    expect(resolveTarget(t(120), t(30), true)).toBe(t(120))
    expect(resolveTarget(t(10), t(30), true)).toBe(t(10))
  })

  test('the origin floor is the one thing allowed to push a target back', () => {
    expect(resolveTarget(t(10), t(30), false, t(60))).toBe(t(60))
  })

  test('probe backoff doubles from 1h and respects both caps', () => {
    const b = { minIntervalMinutes: 5, failingFeedMaxIntervalMinutes: 10080 }
    expect(probeIntervalMinutes(1, b)).toBe(60)
    expect(probeIntervalMinutes(2, b)).toBe(120)
    expect(probeIntervalMinutes(0, b)).toBe(60) // 0 counts as 1
    expect(probeIntervalMinutes(9, b)).toBe(7680) // exponent clamps at 2^7
    expect(probeIntervalMinutes(30, b)).toBe(7680) // the 7d cap sits ABOVE the exponent clamp at defaults
    expect(
      probeIntervalMinutes(5, { minIntervalMinutes: 5, failingFeedMaxIntervalMinutes: 600 }),
    ).toBe(600) // the cap binds when it is lower
    expect(
      probeIntervalMinutes(1, { minIntervalMinutes: 180, failingFeedMaxIntervalMinutes: 10080 }),
    ).toBe(180)
  })
})

describe('planTarget', () => {
  test('unmodelled: error feeds probe, healthy feeds wait out the jittered staleness bound', () => {
    const probe = planTarget(
      { id: FID, url: 'https://x/feed', checkedAt: NOW, nextCheckAt: null, parsingErrorCount: 2 },
      null,
      bounds,
      { nowMs: NOW, justFetched: false },
    )
    expect(probe).toBe(NOW + 120 * 60_000)

    const healthy = planTarget(
      { id: FID, url: 'https://x/feed', checkedAt: NOW, nextCheckAt: null, parsingErrorCount: 0 },
      null,
      bounds,
      { nowMs: NOW, justFetched: false },
    )
    // staleBound = NOW + 1440min * (0.96..1) — a per-feed band, deterministic.
    expect(healthy).toBeGreaterThan(NOW + 1380 * 60_000)
    expect(healthy).toBeLessThanOrEqual(NOW + 1440 * 60_000)
  })

  test('modelled: errors do NOT throttle the learned bells', () => {
    const m = modelOf(steady(1))
    const ok = planTarget(
      { id: FID, url: 'https://x/feed', checkedAt: NOW, nextCheckAt: null, parsingErrorCount: 0 },
      m,
      bounds,
      { nowMs: NOW, justFetched: true },
    )
    const failing = planTarget(
      { id: FID, url: 'https://x/feed', checkedAt: NOW, nextCheckAt: null, parsingErrorCount: 5 },
      m,
      bounds,
      { nowMs: NOW, justFetched: true },
    )
    expect(failing).toBe(ok)
  })

  test('the origin floor survives later ticks (a bell cannot erode it)', () => {
    const floor = NOW + 3 * 3600_000
    const withFloor = planTarget(
      { id: FID, url: 'https://x/feed', checkedAt: NOW, nextCheckAt: null, parsingErrorCount: 0 },
      modelOf(steady(1)),
      bounds,
      { nowMs: NOW, justFetched: true, hintFloorMs: floor },
    )
    expect(withFloor).toBeGreaterThanOrEqual(floor)
    // Next tick: committed target sits at the floor; the bell is earlier and
    // must NOT pull it back inside the floor.
    const later = planTarget(
      {
        id: FID,
        url: 'https://x/feed',
        checkedAt: NOW,
        nextCheckAt: withFloor,
        parsingErrorCount: 0,
      },
      modelOf(steady(1)),
      bounds,
      { nowMs: NOW + 60_000, justFetched: false },
    )
    expect(later).toBeGreaterThanOrEqual(floor)
  })

  test('jitter is deterministic per id and lands in [0, 1)', () => {
    expect(stableJitter('abc')).toBe(stableJitter('abc'))
    expect(stableJitter('abc')).toBeGreaterThanOrEqual(0)
    expect(stableJitter('abc')).toBeLessThan(1)
    expect(stableJitter('abc')).not.toBe(stableJitter('abd'))
  })
})

describe('time helpers', () => {
  test('minuteOfDay stays in range for pre-1970 timestamps', () => {
    expect(minuteOfDay(-1)).toBe(1439)
    expect(minuteOfDay(0)).toBe(0)
    expect(minuteOfDay(NOW)).toBe(12 * 60)
  })

  test('expandMinuteCounts round-trips the histogram', () => {
    const stamps = expandMinuteCounts(
      new Map([
        [60, 2],
        [90, 1],
      ]),
    )
    expect(stamps.sort((a, b) => a - b)).toEqual([60, 60, 90])
    expect(epochDay(TODAY * DAY + 1)).toBe(TODAY)
  })
})
