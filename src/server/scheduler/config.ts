/**
 * Scheduler configuration. Env names, defaults and validation are kept
 * IDENTICAL to the retired app's `loadSchedule()` (src/server/lib/config.ts)
 * so compose.yml interpolation keeps working across the port.
 *
 * Units are minutes (Miniflux parsed these as `minuteType`; "5" = 5 minutes).
 */
export interface SchedulerConfig {
  /** Fastest we may poll any one feed. */
  minIntervalMinutes: number
  /** Slowest we may poll any one feed; also the staleness ceiling. */
  maxIntervalMinutes: number
  /** SCHEDULER_ENTRY_FREQUENCY_FACTOR — multiplies items-expected-today. */
  entryFrequencyFactor: number
  /** Ceiling on polls per feed per day: 1440 / minIntervalMinutes. */
  maxPollsPerDay: number
  /** How far back to learn from published_at. Fixed denominator of the rate. */
  learningWindowDays: number
  /** Half-life (days) of the item-rate EMA. */
  rateHalfLifeDays: number
  /** Ceiling on the failing-feed probe backoff (1h doubling). */
  failingFeedMaxIntervalMinutes: number
  /** /health/scheduler answers 503 once the last completed tick is older than this. */
  maxTickAgeMinutes: number
  /** Eligibility filter: skip feeds at/above this parsing_error_count. 0 = never skip. */
  parsingErrorLimit: number
  /** ntfy topic URL. Empty means alerts are disabled. */
  ntfyUrl: string
  /** Master switch; the `.scheduler-off` flag file beside the DB also pauses it. */
  enabled: boolean
}

const MINUTES_PER_DAY = 1440

const DEFAULT_MIN_INTERVAL_MINUTES = 5
const DEFAULT_MAX_INTERVAL_MINUTES = 1440
const DEFAULT_ENTRY_FREQUENCY_FACTOR = 1
const DEFAULT_LEARNING_WINDOW_DAYS = 90
const DEFAULT_RATE_HALF_LIFE_DAYS = 7
const DEFAULT_FAILING_FEED_MAX_INTERVAL_MINUTES = 10080 // 7d
const DEFAULT_MAX_TICK_AGE_MINUTES = 5

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`)
  }
  return n
}

export function loadSchedulerConfig(): SchedulerConfig {
  const minIntervalMinutes = numEnv(
    'SCHEDULER_ENTRY_FREQUENCY_MIN_INTERVAL',
    DEFAULT_MIN_INTERVAL_MINUTES,
  )
  const maxIntervalMinutes = numEnv(
    'SCHEDULER_ENTRY_FREQUENCY_MAX_INTERVAL',
    DEFAULT_MAX_INTERVAL_MINUTES,
  )
  const entryFrequencyFactor = numEnv(
    'SCHEDULER_ENTRY_FREQUENCY_FACTOR',
    DEFAULT_ENTRY_FREQUENCY_FACTOR,
  )

  if (minIntervalMinutes <= 0) {
    throw new Error('SCHEDULER_ENTRY_FREQUENCY_MIN_INTERVAL must be > 0')
  }
  if (maxIntervalMinutes <= 0) {
    throw new Error('SCHEDULER_ENTRY_FREQUENCY_MAX_INTERVAL must be > 0')
  }
  // Miniflux refused to start on this; fail the same way rather than silently
  // scheduling against contradictory bounds.
  if (minIntervalMinutes > maxIntervalMinutes) {
    throw new Error(
      'SCHEDULER_ENTRY_FREQUENCY_MIN_INTERVAL must be <= SCHEDULER_ENTRY_FREQUENCY_MAX_INTERVAL',
    )
  }
  if (entryFrequencyFactor < 1) {
    throw new Error('SCHEDULER_ENTRY_FREQUENCY_FACTOR must be >= 1')
  }

  return {
    minIntervalMinutes,
    maxIntervalMinutes,
    entryFrequencyFactor,
    maxPollsPerDay: MINUTES_PER_DAY / minIntervalMinutes,
    learningWindowDays: numEnv('SCHEDULER_LEARNING_WINDOW_DAYS', DEFAULT_LEARNING_WINDOW_DAYS),
    rateHalfLifeDays: numEnv('SCHEDULER_RATE_HALF_LIFE_DAYS', DEFAULT_RATE_HALF_LIFE_DAYS),
    failingFeedMaxIntervalMinutes: numEnv(
      'SCHEDULER_FAILING_FEED_MAX_INTERVAL_MINUTES',
      DEFAULT_FAILING_FEED_MAX_INTERVAL_MINUTES,
    ),
    maxTickAgeMinutes: numEnv('SCHEDULER_MAX_TICK_AGE_MINUTES', DEFAULT_MAX_TICK_AGE_MINUTES),
    parsingErrorLimit: numEnv('POLLING_PARSING_ERROR_LIMIT', 0),
    ntfyUrl: process.env.SCHEDULER_NTFY_URL || process.env.MINIFLUX_SCHEDULER_NTFY_URL || '',
    enabled: process.env.SCHEDULER_ENABLED !== '0',
  }
}
