/**
 * Pure feed-scheduling model. No I/O — everything here is unit-testable.
 *
 * Ported verbatim from the validated reference implementation
 * (src/server/lib/schedule/model.ts of the retired Miniflux-supervisor app,
 * itself ported from playground/scripts/poll-sim.ts). Two deltas, both because
 * this app IS the fetcher and the only writer of `next_check_at`:
 *
 * - `decodeCacheHintMinutes` / `entryFrequencyIntervalMinutes` are GONE. They
 *   existed to recover a cache hint Miniflux had folded into `next_check_at`.
 *   Here the fetcher reads `Retry-After` / `Cache-Control` / `Expires` itself,
 *   so the hint is exact data applied as a floor — which also closes the old
 *   doc's "short cache hints are unrecoverable" limitation.
 * - Feed ids are UUID strings, so the per-feed jitter hash is FNV-1a over the
 *   id string (UUIDv7 ids share a time prefix; hashing the id itself would
 *   correlate neighbours).
 *
 * Times of day are UTC minutes 0..1439; days are UTC epoch-day numbers.
 */
import type { FeedId } from '../../shared/ids'

export const MINUTES_PER_DAY = 1440
const MS_PER_DAY = 86_400_000

// ---- density / modes ----
const DENSITY_BINS = 48
const BIN_MINUTES = MINUTES_PER_DAY / DENSITY_BINS // 30
const SMOOTH_PASSES = 3
const CONCENTRATION_RATIO = 3 // concentrated = peak > 3 * mean
const MODE_PEAK_FRACTION = 0.2 // bin must reach 20% of peak to be a mode
const RAW_MODE_SUPPORT = 3 // a mode needs >= 3 raw samples in its bin

// ---- budget ----
const DATE_ONLY_MIN_POLLUTES = 3
const MIN_DOW_SAMPLES = 12 // weekday gate needs >= 12 DISTINCT active days to mean anything

// ---- placement ----
/** Place the last poll this far past the observed tail, so a delivery that
 *  drifts past every seen publish time is still caught the same day. */
const TAIL_MARGIN_MINUTES = 20
/** Retry cadence while an expected delivery has not yet arrived. */
export const RETRY_STEP_MINUTES = 10
/** How far past the delivery window retries keep looking. Drift is the norm
 *  (QC has run an hour late), and the chain STOPS on delivery, so a generous
 *  reach costs one or two requests on a normal day and buys the late ones. */
export const RETRY_REACH_MINUTES = 120
/** Hard ceiling on the chain, so a feed that never delivers cannot spin. */
export const MAX_RETRIES = 24
/** Insurance spacing, for feeds that publish outside their learned window. */
const INSURANCE_MINUTES = 240
/** Above this share of out-of-window publishes, insurance is worth paying for. */
export const OUTSIDE_FRAC_THRESHOLD = 0.05

export interface FeedInput {
  feedId: FeedId
  /** Minute-of-day (0..1439) of every published entry in the window, with multiplicity. */
  stamps: number[]
  /** Entry count per UTC day (epoch-day number -> count). */
  dayCounts: Map<number, number>
}

export interface ScheduleOptions {
  /** SCHEDULER_ENTRY_FREQUENCY_FACTOR — multiplies items-expected-today. */
  entryFrequencyFactor: number
  /** Ceiling on polls per feed per day. */
  maxPollsPerDay: number
  /**
   * SCHEDULER_LEARNING_WINDOW_DAYS. Used as the FIXED denominator of the
   * no-weekday-signal rate.
   */
  learningWindowDays: number
  /** SCHEDULER_RATE_HALF_LIFE_DAYS — how fast the item-rate EMA tracks a feed. */
  rateHalfLifeDays: number
  /** UTC epoch-day of "today"; the EMA is anchored here. */
  nowEpochDay: number
}

export interface FeedModel {
  feedId: FeedId
  /** All entries stamped midnight exactly: no time-of-day signal exists. */
  dateOnly: boolean
  /** Density has a peak > 3x its mean. */
  concentrated: boolean
  numModes: number
  peak: number
  /** Poll budget per weekday (0 = Sunday). */
  budget: number[]
  dowSignal: boolean
  publishDays: Set<number>
  /** Cached poll placement (minutes-of-day, ascending) for a weekday's budget. */
  pollMinutes(dow: number): number[]
  /** Share of stamps landing outside the delivery window. > 0.05 means the feed
   *  HAS published at an unexpected hour, so insurance polling is earned. */
  outsideFrac: number
  /** Start of the ~90%-mass delivery window, in minutes-of-day (UTC). */
  deliveryStartMinute: number
  /** Width of that window in minutes. */
  deliverySpanMinute: number
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))

/** UTC day-of-week (0 = Sunday) for an epoch-day number. */
export function dayOfWeek(epochDay: number): number {
  return new Date(epochDay * MS_PER_DAY).getUTCDay()
}

/** UTC epoch-day number for a timestamp. */
export function epochDay(ms: number): number {
  return Math.floor(ms / MS_PER_DAY)
}

/** Minute-of-day (0..1439) for a timestamp, truncated to whole minutes. The
 *  double modulo keeps pre-1970 (negative) timestamps positive — JS `%` keeps
 *  the sign of the dividend, so `minuteOfDay` would otherwise return negatives
 *  and silently break its 0..1439 contract. */
export function minuteOfDay(ms: number): number {
  return Math.floor((((ms % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY) / 60_000)
}

/** Expand a minute-of-day count histogram back into a stamp multiset. */
export function expandMinuteCounts(minuteCounts: Map<number, number>): number[] {
  const stamps: number[] = []
  for (const [minute, count] of minuteCounts) {
    for (let i = 0; i < count; i++) stamps.push(minute)
  }
  return stamps
}

/**
 * Seam rotation: cut the circular day at its quietest 30-minute bin so the
 * wrap point never splits a mode. Rotating by -seamBin*30 turns the circle
 * into a line where quantiles are well defined. Everything downstream
 * (quantiles) works on rotated minutes; `toOrig` maps back at the end.
 */
function rotate(stamps: number[]): { rot: number[]; seamBin: number } {
  const hist = new Array<number>(DENSITY_BINS).fill(0)
  for (const s of stamps) {
    const bin = Math.floor(
      (((s % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY) / BIN_MINUTES,
    )
    hist[bin] = (hist[bin] as number) + 1
  }
  // First strictly-smallest bin wins ties (matches the sim's scan order).
  let seam = 0
  for (let i = 1; i < DENSITY_BINS; i++) {
    if ((hist[i] as number) < (hist[seam] as number)) seam = i
  }
  const rot = stamps
    .map((s) => (((s - seam * BIN_MINUTES) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY)
    .sort((a, b) => a - b)
  return { rot, seamBin: seam }
}

/** Weighted empirical quantile (linear interpolation) over a sorted multiset. */
function quantile(sorted: number[], t: number): number {
  if (sorted.length === 0) return 0
  const idx = clamp(t * (sorted.length - 1), 0, sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.min(sorted.length - 1, lo + 1)
  return (sorted[lo] as number) + (idx - lo) * ((sorted[hi] as number) - (sorted[lo] as number))
}

/**
 * Exponentially weighted item rate, in items/day, over the learning window.
 * See the design doc (docs/feed-scheduler.md) for why this replaces both a
 * flat window average and the mean-gap formula: a per-day count cannot be
 * inflated by within-day clustering, and the `1 − decay^learnDays` normalisation
 * makes a steady feed report exactly its rate at any half-life.
 */
export function emaDailyCount(
  dayCounts: Map<number, number>,
  nowEpochDay: number,
  halfLifeDays: number,
  learnDays: number,
): number {
  const alpha = 1 - Math.pow(2, -1 / Math.max(halfLifeDays, 0.1))
  const decay = 1 - alpha
  let ema = 0
  // Oldest -> newest so today's sample carries weight alpha.
  for (let k = learnDays - 1; k >= 0; k--) {
    ema = ema * decay + (dayCounts.get(nowEpochDay - k) ?? 0) * alpha
  }
  const mass = 1 - Math.pow(decay, learnDays)
  return mass > 1e-9 ? ema / mass : ema
}

export function buildFeedModel(input: FeedInput, opts: ScheduleOptions): FeedModel | null {
  const stamps = input.stamps.filter((s) => s >= 0 && s < MINUTES_PER_DAY)
  const N = stamps.length
  if (N === 0) return null

  // Date-only feeds: every entry stamped exactly midnight UTC — no time-of-day
  // signal exists, so polls are spread uniformly instead of chasing a phantom mode.
  const dateOnly = stamps.every((s) => s === 0)

  const { rot, seamBin } = rotate(stamps)
  const toOrig = (v: number) =>
    (((v + seamBin * BIN_MINUTES) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY

  // 48-bin density over rotated minutes, smoothed 3x with the circular
  // [1,2,1]/4 kernel. Rotation keeps a mode that straddles midnight from being
  // split in two by the day boundary; the smoothing is what the mode-counting
  // below reads.
  const dh = new Array<number>(DENSITY_BINS).fill(0)
  for (const s of stamps) {
    const bin = Math.floor(
      ((((s - seamBin * BIN_MINUTES) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY) /
        BIN_MINUTES,
    )
    dh[bin] = (dh[bin] as number) + 1
  }
  let dens = dh
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    dens = dens.map(
      (_, i) =>
        0.25 * (dens[(i - 1 + DENSITY_BINS) % DENSITY_BINS] as number) +
        0.5 * (dens[i] as number) +
        0.25 * (dens[(i + 1) % DENSITY_BINS] as number),
    )
  }
  const peak = Math.max(...dens)
  const meanDens = dens.reduce((a, b) => a + b, 0) / DENSITY_BINS
  const concentrated = peak > CONCENTRATION_RATIO * meanDens

  // Smallest window holding ~90% of the mass -- where a delivery is expected --
  // and the share of stamps landing OUTSIDE it. The window drives retry-until-
  // delivery; the share says whether insurance polling is worth paying for.
  const totalDens = dens.reduce((a, b) => a + b, 0)
  let deliverySpan = MINUTES_PER_DAY
  let deliveryStart = 0
  for (let s = 0; s < DENSITY_BINS; s++) {
    let acc = 0
    let span = 0
    for (let k = 0; k < DENSITY_BINS; k++) {
      acc += dens[(s + k) % DENSITY_BINS] as number
      span = (k + 1) * BIN_MINUTES
      if (acc >= 0.9 * totalDens) break
    }
    if (span < deliverySpan) {
      deliverySpan = span
      deliveryStart = s * BIN_MINUTES
    }
  }
  const inDeliveryWindow = (m: number) =>
    (m - deliveryStart + MINUTES_PER_DAY) % MINUTES_PER_DAY <= deliverySpan
  // Stamps past the window AND the retry reach: the publishes retry-until-
  // delivery cannot see by construction. That is what insurance exists for.
  const reach = deliverySpan + 60
  const outsideFrac = stamps.length
    ? stamps.filter((m) => (m - deliveryStart + MINUTES_PER_DAY) % MINUTES_PER_DAY > reach).length /
      stamps.length
    : 0
  void inDeliveryWindow

  // Count significant modes so a bimodal feed cannot starve its minority mode.
  // The RAW-count support requirement is essential: without it sparse feeds
  // get phantom modes from the smoothing alone.
  let numModes = 1
  if (concentrated) {
    numModes = 0
    for (let i = 0; i < DENSITY_BINS; i++) {
      const prev = dens[(i - 1 + DENSITY_BINS) % DENSITY_BINS] as number
      const next = dens[(i + 1) % DENSITY_BINS] as number
      const hit =
        (dens[i] as number) >= MODE_PEAK_FRACTION * peak &&
        (dens[i] as number) >= prev &&
        (dens[i] as number) > next &&
        (dh[i] as number) >= RAW_MODE_SUPPORT
      if (hit) numModes++
    }
    numModes = Math.max(1, numModes)
  }

  const activeDays = input.dayCounts.size
  const learnDays = opts.learningWindowDays

  // Weekday gate: only trust the day-of-week pattern with enough DISTINCT days,
  // and count days rather than entries. Counting entries lets one burst invent
  // a weekly commitment.
  const dowDays = new Array<number>(7).fill(0)
  for (const day of input.dayCounts.keys()) {
    const dow = dayOfWeek(day)
    dowDays[dow] = (dowDays[dow] as number) + 1
  }
  const publishDays = new Set<number>()
  // A weekday counts as a publish day if it carries at least half the AVERAGE
  // number of active days. A fixed share is fragile: a feed that posts every
  // day lands at ~1/7 per weekday and ordinary sampling noise flips the gate.
  const minDaysPerDow = Math.max(1, activeDays / 14)
  for (let d = 0; d < 7; d++) {
    if ((dowDays[d] as number) >= minDaysPerDow) publishDays.add(d)
  }
  const dowSignal = activeDays >= MIN_DOW_SAMPLES && publishDays.size > 0 && publishDays.size < 7

  // Budget = items expected TODAY. Rate is an EMA of per-day entry counts;
  // `perActiveDay` scales it back to "per day it actually posts" so the weekday
  // gate can spend it all on a publish day: with no weekday signal the two
  // factors cancel and the budget is just the EMA itself.
  const ratePerDay = emaDailyCount(
    input.dayCounts,
    opts.nowEpochDay,
    opts.rateHalfLifeDays,
    learnDays,
  )
  const perActiveDay = (ratePerDay * learnDays) / Math.max(1, activeDays)
  // ceil() with an epsilon: the EMA is iterative float arithmetic, so a feed
  // that is exactly N/day can compute as N+1e-12 and ceil() it up to N+1.
  const CEIL_EPS = 1e-9
  // The floor must never exceed the ceiling: a date-only feed on an instance
  // configured for < 3 polls/day would otherwise get clamp(x, 3, 2) = 3 and
  // silently poll MORE often than the configured maximum.
  //
  // Two polls on a day we expect a delivery: one inside the bell, one past the
  // observed tail. That pair is what catches a delivery that drifts late, which
  // is why the floor is 2 and not 1. A day with no expected delivery needs only
  // one, so it is left alone.
  const floorFor = (p: number) =>
    Math.min(dateOnly ? DATE_ONLY_MIN_POLLUTES : p > 0 ? 2 : 1, opts.maxPollsPerDay)
  const budget: number[] = []
  for (let d = 0; d < 7; d++) {
    const p = dowSignal ? (publishDays.has(d) ? 1 : 0) : activeDays / learnDays
    budget.push(
      clamp(
        Math.max(
          Math.ceil(perActiveDay * p * opts.entryFrequencyFactor - CEIL_EPS),
          p >= 1 ? numModes : 1,
        ),
        floorFor(p),
        opts.maxPollsPerDay,
      ),
    )
  }

  // Placement depends only on B, so cache one schedule per distinct B.
  const ptCache = new Map<number, number[]>()
  let tailRot = 0
  for (const v of rot) if (v > tailRot) tailRot = v
  const tailMinute = toOrig(tailRot)
  const pollMinutes = (dow: number): number[] => {
    const b = budget[dow] ?? 1
    const hit = ptCache.get(b)
    if (hit) return hit
    const pts: number[] = []
    if (dateOnly) {
      // No time-of-day signal: uniform coverage of the day.
      for (let k = 1; k <= b; k++) pts.push(((k - 0.5) * MINUTES_PER_DAY) / b)
    } else {
      // Last poll sits past the observed tail, so a delivery that lands after
      // every previously seen publish time is still caught today. The earlier
      // polls sit at the centres of equal-mass slices -- proportional to the
      // histogram, one poll per mode region.
      const last = (tailMinute + TAIL_MARGIN_MINUTES) % MINUTES_PER_DAY
      for (let k = 1; k <= b; k++) {
        const m = toOrig(quantile(rot, (k - 0.5) / b))
        pts.push(k === b ? Math.max(m, last) : m)
      }
      pts.push(last)
    }
    // Insurance: only for feeds with a measured history of publishing past
    // their window, and only in the STRETCHED-OUT gaps. A feed already polled
    // every 36 minutes has nothing to insure; one polled twice a day does.
    if (outsideFrac > OUTSIDE_FRAC_THRESHOLD) {
      const filled: number[] = []
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i] as number
        const b = pts[(i + 1) % pts.length] as number
        const gap = (b - a + MINUTES_PER_DAY) % MINUTES_PER_DAY
        for (let g = INSURANCE_MINUTES; g < gap; g += INSURANCE_MINUTES) {
          filled.push((a + g) % MINUTES_PER_DAY)
        }
      }
      pts.push(...filled)
      pts.sort((x, y) => x - y)
    }
    pts.sort((x, y) => x - y)
    const uniq: number[] = []
    for (const t of pts) {
      if (!uniq.length || t - (uniq[uniq.length - 1] as number) > 1) uniq.push(t)
    }
    ptCache.set(b, uniq)
    return uniq
  }

  return {
    feedId: input.feedId,
    dateOnly,
    concentrated,
    numModes,
    peak,
    budget,
    dowSignal,
    publishDays,
    outsideFrac,
    deliveryStartMinute: deliveryStart,
    deliverySpanMinute: deliverySpan,
    pollMinutes,
  }
}

/**
 * A target we already committed to is replaced only by an EARLIER one.
 *
 * Two failures come from not doing this:
 *   - a retry/probe target (anchor + minutes) gets rewritten to the next bell
 *     one tick later and the retry chain never fires;
 *   - a target that expired before the fetcher consumed it is raised to the
 *     following bell — "never due at all".
 *
 * `justFetched` is the one exception: right after a fetch the fresh target is
 * a real plan rather than a stale commitment, so it replaces freely.
 *
 * `hintFloorMs` is the origin's Retry-After / cache floor: the one thing
 * allowed to push a target back out.
 */
export function resolveTarget(
  candidateMs: number,
  currentNextMs: number | null,
  justFetched: boolean,
  hintFloorMs?: number | null,
): number {
  let t = candidateMs
  if (!justFetched && currentNextMs != null) t = Math.min(t, currentNextMs)
  if (hintFloorMs != null) t = Math.max(t, hintFloorMs)
  return t
}

/**
 * Earliest scheduled poll instant strictly after `afterMs`, scanning UTC day
 * offsets 0..maxDayOffset and each poll minute of that day's budget.
 */
export function nextPollInstant(model: FeedModel, afterMs: number, maxDayOffset = 7): Date | null {
  const base = epochDay(afterMs) * MS_PER_DAY
  for (let off = 0; off <= maxDayOffset; off++) {
    const dayStart = base + off * MS_PER_DAY
    const dow = new Date(dayStart).getUTCDay()
    for (const m of model.pollMinutes(dow)) {
      const t = dayStart + m * 60_000
      if (t > afterMs) return new Date(t)
    }
  }
  return null
}

/**
 * Failing-feed probe interval: 1h doubling per consecutive failure, floored at
 * the minimum interval (NOT an entry-frequency interval, or feeds that merely
 * look high-volume get hammered) and capped so nothing is ever dead for good.
 *
 * This is the ONLY place error backoff applies — see docs/feed-scheduler.md.
 * `parsing_error_count` is the streak counter for free: it increments per
 * failure and zeroes on success.
 */
export function probeIntervalMinutes(
  errorCount: number,
  bounds: { minIntervalMinutes: number; failingFeedMaxIntervalMinutes: number },
): number {
  const exponent = Math.min(Math.max(errorCount, 1), 8) - 1
  return Math.min(
    Math.max(60 * 2 ** exponent, bounds.minIntervalMinutes),
    bounds.failingFeedMaxIntervalMinutes,
  )
}

/** Stable 0..1 jitter per feed id (FNV-1a). UUIDv7 ids share a time prefix,
 *  so hashing the id itself would correlate neighbours. */
export function stableJitter(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) / 4294967296
}

export interface FeedScheduleState {
  id: FeedId
  /** The host is the unit politeness is measured at. */
  url: string
  /** Last fetch time — the stable anchor for now-relative targets. */
  checkedAt: number | null
  /** Current committed target (epoch-ms), or null when never scheduled. */
  nextCheckAt: number | null
  parsingErrorCount: number
}

export interface PlanContext {
  nowMs: number
  /** A fetch completed since the previous plan: replace the target freely. */
  justFetched: boolean
  /** The origin's floor (Retry-After / cache freshness), when it spoke. */
  hintFloorMs?: number | null
}

export interface PlanBounds {
  minIntervalMinutes: number
  maxIntervalMinutes: number
  failingFeedMaxIntervalMinutes: number
  entryFrequencyFactor: number
  maxPollsPerDay: number
  learningWindowDays: number
  rateHalfLifeDays: number
}

/**
 * The per-feed decision, extracted from the old runner so it is unit-testable.
 * Anchors every now-relative target to `checkedAt` — recomputing `now + X` each
 * tick makes the deadline CHASE THE CLOCK (the tolerance check compares the
 * recomputed value against the previous write and rewrites), so the deadline
 * slides forward forever and never becomes due. `checkedAt` is a stable anchor.
 */
export function planTarget(
  feed: FeedScheduleState,
  model: FeedModel | null,
  bounds: PlanBounds,
  ctx: PlanContext,
): number {
  const anchorMs = feed.checkedAt ?? ctx.nowMs
  // Per-feed jitter band on the staleness bound. A shared checked_at produces a
  // shared bound, so every feed fetched together would become due together 24h
  // later and reproduce the cluster forever. 4% of a 24h maxInterval = 57.6min.
  const jitter = stableJitter(feed.id)
  const staleBoundMs = anchorMs + bounds.maxIntervalMinutes * 60_000 * (0.96 + 0.04 * jitter)

  let targetMs: number
  if (!model) {
    // No learned schedule to preserve: a plain probe interval is the best we
    // have, and the ONLY place error backoff applies.
    targetMs =
      feed.parsingErrorCount > 0
        ? anchorMs + probeIntervalMinutes(feed.parsingErrorCount, bounds) * 60_000
        : staleBoundMs
  } else {
    // Always the learned bells. Errors do NOT throttle them — a 502 is the
    // server failing, not asking us to slow down. Retry-After is the one error
    // signal that IS the origin speaking, and it is a floor below.
    const next = nextPollInstant(model, ctx.nowMs)
    targetMs = next ? next.getTime() : staleBoundMs
  }

  // Staleness ceiling: never later than maxInterval since the last REAL check,
  // spread per-feed. Superseded only on the unmodelled probe path, where
  // SCHEDULER_FAILING_FEED_MAX_INTERVAL_MINUTES is the binding cap.
  const probed = !model && feed.parsingErrorCount > 0
  if (!probed) targetMs = Math.min(targetMs, staleBoundMs)

  // Never postpone a target we already committed to; the origin's floor is the
  // one thing allowed to push back.
  return resolveTarget(targetMs, feed.nextCheckAt, ctx.justFetched, ctx.hintFloorMs)
}
