/**
 * Health payloads, kept separate from the route so they can be asserted without
 * a database or a running scheduler.
 *
 * Two questions, two URLs — because they have different answers:
 *
 *   /health            "should this container be restarted?"  503 only when the
 *                      process cannot reach its database.
 *   /health/scheduler  "is the poller keeping up?"            503 when the last
 *                      completed tick is stale or absent.
 *
 * A stale tick is *not* a reason to restart: a restart interrupts the very work
 * that is behind, and a cold first tick on a large database legitimately takes
 * minutes. So the liveness endpoint reports the scheduler in its body (and a
 * `degraded` flag) while still answering 200.
 */
import type { Heartbeat } from './scheduler/heartbeat'

export interface HealthReport {
  status: 200 | 503
  body: Record<string, unknown>
}

export interface SchedulerState extends Heartbeat {
  /** Minutes since the last completed tick; null when none has completed. */
  tickAgeMinutes: number | null
  /** Enabled but not keeping up (no completed tick yet, or past the ceiling). */
  stale: boolean
}

const schedulerState = (
  heartbeat: Heartbeat,
  staleAfterMinutes: number,
  now: Date,
): SchedulerState => {
  const tickAgeMinutes = heartbeat.lastTickAt
    ? (now.getTime() - heartbeat.lastTickAt.getTime()) / 60_000
    : null
  // A scheduler that was never started (disabled by config) is a choice, not a
  // fault — the same rule the old single-endpoint version applied.
  const stale = heartbeat.enabled && (tickAgeMinutes == null || tickAgeMinutes > staleAfterMinutes)
  return { ...heartbeat, tickAgeMinutes, stale }
}

/** Liveness: the process can serve, and its database answers. */
export const livenessReport = (
  probeDatabase: () => void,
  heartbeat: Heartbeat,
  staleAfterMinutes: number,
  now: Date = new Date(),
): HealthReport => {
  let databaseOk = true
  try {
    probeDatabase()
  } catch (error) {
    // Deliberately not echoed: a SQLite error can carry the database path, and
    // this endpoint is unauthenticated. The route logs it.
    void error
    databaseOk = false
  }
  const scheduler = schedulerState(heartbeat, staleAfterMinutes, now)
  return {
    status: databaseOk ? 200 : 503,
    body: {
      ok: databaseOk,
      database: databaseOk ? { ok: true } : { ok: false },
      scheduler,
      // Informative, never part of the status: a lagging poller is not a
      // reason to restart this process.
      degraded: scheduler.stale,
      uptimeSeconds: Math.round(process.uptime()),
    },
  }
}

/** Poller liveness on its own URL, with the status monitoring wants. */
export const schedulerReport = (
  heartbeat: Heartbeat,
  staleAfterMinutes: number,
  now: Date = new Date(),
): HealthReport => {
  const scheduler = schedulerState(heartbeat, staleAfterMinutes, now)
  return { status: scheduler.stale ? 503 : 200, body: { ok: !scheduler.stale, scheduler } }
}
