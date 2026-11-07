import { expect, test } from 'bun:test'

import type { Heartbeat } from '../src/server/scheduler/heartbeat'
import { livenessReport, schedulerReport } from '../src/server/health'

const NOW = new Date('2026-01-01T12:00:00Z')

const heartbeat = (overrides: Partial<Heartbeat> = {}): Heartbeat => ({
  enabled: true,
  lastTickAt: new Date(NOW.getTime() - 60_000),
  lastAttemptAt: new Date(NOW.getTime() - 60_000),
  lastTickOk: true,
  lastTickError: null,
  ...overrides,
})

test('/health is 200 while the database answers', () => {
  const report = livenessReport(() => {}, heartbeat(), 5, NOW)
  expect(report.status).toBe(200)
  expect(report.body.ok).toBe(true)
  expect(report.body.database).toEqual({ ok: true })
  expect(typeof report.body.uptimeSeconds).toBe('number')
})

test('/health is 503 when the database probe throws', () => {
  const report = livenessReport(
    () => {
      throw new Error('unable to open database file: /srv/spfy-rss/reader.sqlite')
    },
    heartbeat(),
    5,
    NOW,
  )
  expect(report.status).toBe(503)
  expect(report.body.ok).toBe(false)
  expect(report.body.database).toEqual({ ok: false })
  // The endpoint is unauthenticated: a driver message can carry a file path.
  expect(JSON.stringify(report.body)).not.toContain('reader.sqlite')
})

// The whole point of the split: a lagging poller must not restart a healthy
// server, because the restart interrupts the work that is behind.
test('/health stays 200 with a stale scheduler, and says so', () => {
  const stale = heartbeat({ lastTickAt: new Date(NOW.getTime() - 60 * 60_000) })
  const report = livenessReport(() => {}, stale, 5, NOW)
  expect(report.status).toBe(200)
  expect(report.body.degraded).toBe(true)
  expect((report.body.scheduler as { stale: boolean }).stale).toBe(true)
})

test('/health/scheduler is the alert: 503 once a completed tick is stale', () => {
  expect(schedulerReport(heartbeat(), 5, NOW).status).toBe(200)

  const stale = heartbeat({ lastTickAt: new Date(NOW.getTime() - 6 * 60_000) })
  expect(schedulerReport(stale, 5, NOW).status).toBe(503)

  // Never completed a tick (cold start, or every tick failing): stale.
  const never = heartbeat({ lastTickAt: null })
  const neverReport = schedulerReport(never, 5, NOW)
  expect(neverReport.status).toBe(503)
  expect(
    (neverReport.body.scheduler as { tickAgeMinutes: number | null }).tickAgeMinutes,
  ).toBeNull()
})

test('a disabled scheduler is a choice, not a failure, on both endpoints', () => {
  const disabled = heartbeat({ enabled: false, lastTickAt: null })
  expect(schedulerReport(disabled, 5, NOW).status).toBe(200)
  const liveness = livenessReport(() => {}, disabled, 5, NOW)
  expect(liveness.status).toBe(200)
  expect(liveness.body.degraded).toBe(false)
})

test('a failed tick does not refresh freshness', () => {
  // markTick(ok=false) leaves lastTickAt alone, so persistent failures age out.
  const failing = heartbeat({
    lastTickAt: new Date(NOW.getTime() - 30 * 60_000),
    lastTickOk: false,
    lastTickError: 'scheduler tick timed out',
  })
  const report = schedulerReport(failing, 5, NOW)
  expect(report.status).toBe(503)
  expect((report.body.scheduler as { lastTickError: string }).lastTickError).toContain('timed out')
})
