/**
 * Tick-freshness state for the scheduler loop and the health reports.
 *
 * A tick only counts as *completed* when it succeeded — a failed tick records
 * the error but does not refresh `lastTickAt`, so persistent failures age out and
 * the staleness report goes bad instead of pretending all is well.
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

export interface Heartbeat {
  /** True once startScheduler() has run. */
  enabled: boolean
  /** Last successful (completed) tick. */
  lastTickAt: Date | null
  /** Most recent tick attempt, success or failure. */
  lastAttemptAt: Date | null
  lastTickOk: boolean | null
  lastTickError: string | null
}

const empty = (): Heartbeat => ({
  enabled: false,
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
    enabled: heartbeat.enabled,
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
    // to "never ticked", which is the safe direction.
    console.error('scheduler: could not persist heartbeat', error)
  }
}

const parse = (raw: string): Heartbeat => {
  const data = JSON.parse(raw) as Record<string, unknown>
  const date = (value: unknown) => (typeof value === 'string' ? new Date(value) : null)
  return {
    enabled: data['enabled'] === true,
    lastTickAt: date(data['lastTickAt']),
    lastAttemptAt: date(data['lastAttemptAt']),
    lastTickOk: typeof data['lastTickOk'] === 'boolean' ? data['lastTickOk'] : null,
    lastTickError: typeof data['lastTickError'] === 'string' ? data['lastTickError'] : null,
  }
}

export function markSchedulerStarted(): void {
  state.enabled = true
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
