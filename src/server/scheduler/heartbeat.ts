/**
 * Tick-freshness and run-state for the scheduler loop and the health reports.
 *
 * A tick only counts as *completed* when it succeeded — a failed tick records
 * the error but does not refresh `lastTickAt`, so persistent failures age out and
 * the staleness report goes bad instead of pretending all is well.
 *
 * `phase` is the one place the loop's run-state lives. Without it, "disabled by
 * config", "paused via the off-flag", and "running" were indistinguishable from
 * a heartbeat's timestamps: pausing had to manufacture successful ticks to stay
 * fresh, and a deliberately disabled scheduler inherited the previous run's file
 * and read as broken.
 *
 * **Why a file.** The scheduler and the HTTP handler are different module graphs
 * in production (`server.ts` imports `src/` directly; the routes come from the
 * bundled `dist/server/server.js`), and different *processes* in dev (Vite serves,
 * `startup-cli.ts` polls). In-memory state therefore reads as "never ticked" from
 * the health route — a silently dead alert. The heartbeat is written next to the
 * database, beside the existing `.scheduler-off` flag, so whatever serves HTTP can
 * see what the poller is actually doing.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { appDbPath } from '../db-app'

/**
 * What the loop is doing right now.
 *
 * - `unknown` — no heartbeat file. The web process has no evidence either way,
 *   which is exactly what "the poller never booted" looks like.
 * - `running` — the loop is live; `lastTickAt` says whether it is keeping up.
 * - `paused`   — the off-flag is present. A choice, not a fault.
 * - `disabled` — `SCHEDULER_ENABLED=0`. Also a choice.
 */
export type SchedulerPhase = 'unknown' | 'running' | 'paused' | 'disabled'

export interface Heartbeat {
  phase: SchedulerPhase
  /** Last successful (completed) tick. */
  lastTickAt: Date | null
  /** Most recent tick attempt, success or failure. */
  lastAttemptAt: Date | null
  lastTickOk: boolean | null
  lastTickError: string | null
}

const empty = (): Heartbeat => ({
  phase: 'unknown',
  lastTickAt: null,
  lastAttemptAt: null,
  lastTickOk: null,
  lastTickError: null,
})

export const heartbeatPath = (): string => join(dirname(appDbPath()), '.scheduler-heartbeat')

/** In-process view, for the loop's own gap reporting. */
const state: Heartbeat = empty()

const serialize = (heartbeat: Heartbeat): string =>
  JSON.stringify({
    phase: heartbeat.phase,
    lastTickAt: heartbeat.lastTickAt?.toISOString() ?? null,
    lastAttemptAt: heartbeat.lastAttemptAt?.toISOString() ?? null,
    lastTickOk: heartbeat.lastTickOk,
    lastTickError: heartbeat.lastTickError,
  })

/** Write via a temp file + rename so a reader never sees half a heartbeat. */
const persist = (): void => {
  try {
    const path = heartbeatPath()
    const temp = `${path}.tmp`
    writeFileSync(temp, serialize(state))
    renameSync(temp, path)
  } catch (error) {
    // A read-only data dir must not take the scheduler down; the alert degrades
    // to "no heartbeat", which the health route reports as unknown.
    console.error('scheduler: could not persist heartbeat', error)
  }
}

const isPhase = (value: unknown): value is SchedulerPhase =>
  value === 'unknown' || value === 'running' || value === 'paused' || value === 'disabled'

const parse = (raw: string): Heartbeat => {
  const data = JSON.parse(raw) as Record<string, unknown>
  const date = (value: unknown) => (typeof value === 'string' ? new Date(value) : null)
  return {
    // A file written before `phase` existed carried `enabled`; map it rather
    // than reporting a running scheduler as unknown until the next boot.
    phase: isPhase(data['phase'])
      ? data['phase']
      : data['enabled'] === true
        ? 'running'
        : 'disabled',
    lastTickAt: date(data['lastTickAt']),
    lastAttemptAt: date(data['lastAttemptAt']),
    lastTickOk: typeof data['lastTickOk'] === 'boolean' ? data['lastTickOk'] : null,
    lastTickError: typeof data['lastTickError'] === 'string' ? data['lastTickError'] : null,
  }
}

export function markSchedulerStarted(): void {
  state.phase = 'running'
  persist()
}

/** `SCHEDULER_ENABLED=0`: record the choice so a stale file cannot outlive it. */
export function markSchedulerDisabled(): void {
  state.phase = 'disabled'
  persist()
}

/** The off-flag was seen: polling is off, but the loop is alive to notice. */
export function markPaused(): void {
  state.phase = 'paused'
  persist()
}

/** The off-flag was removed: polling resumes. */
export function markSchedulerResumed(): void {
  state.phase = 'running'
  persist()
}

export function markTick(ok: boolean, error?: string): void {
  state.lastAttemptAt = new Date()
  state.lastTickOk = ok
  state.lastTickError = ok ? null : (error ?? 'unknown error')
  if (ok) state.lastTickAt = state.lastAttemptAt
  persist()
}

/** The in-process heartbeat (what this process has done). */
export function getHeartbeat(): Heartbeat {
  return { ...state }
}

/**
 * The heartbeat any process can read. Falls back to the in-process copy when the
 * file is absent (a scheduler that has never run), which keeps unit tests and
 * one-process development honest.
 */
export function readHeartbeat(): Heartbeat {
  const path = heartbeatPath()
  if (!existsSync(path)) return getHeartbeat()
  try {
    return parse(readFileSync(path, 'utf8'))
  } catch {
    return getHeartbeat()
  }
}

/** Minutes since the last completed tick; null when none happened. */
export function lastTickAgeMinutes(now: Date = new Date()): number | null {
  if (!state.lastTickAt) return null
  return (now.getTime() - state.lastTickAt.getTime()) / 60_000
}
