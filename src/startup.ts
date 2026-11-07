import { appDb } from './server/db-app'
import { startScheduler as launchScheduler } from './server/scheduler'

/**
 * Long-lived background work: the feed scheduler.
 *
 * Called from `server.ts` before serving (one process owns the SQLite file in
 * prod), and from `src/startup-cli.ts` in dev, where Vite owns the web server
 * and this runs as its own watched process — HMR must never reload the
 * scheduler into a second concurrent loop.
 */
const g = globalThis as typeof globalThis & { __readerSchedulerStop?: (() => void) | null }

export const startScheduler = (): void => {
  // Guarded so an accidental double call (a reload, a second entry) cannot
  // stack loops; the second caller is a no-op rather than an error.
  if (g.__readerSchedulerStop !== undefined) return

  try {
    g.__readerSchedulerStop = launchScheduler({ handle: appDb() })
    // null means the scheduler declined to run (disabled by config) and has
    // already said why — do not announce it as running.
    if (g.__readerSchedulerStop) console.log('Feed scheduler running')
  } catch (error) {
    console.error('scheduler: failed to start', error)
    g.__readerSchedulerStop = null
    return
  }

  // Registering a signal handler replaces the default "die on SIGTERM", so the
  // handler has to exit itself: `docker stop` (and a test harness) would
  // otherwise wait out the kill timeout on a process that only paused its loop.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      g.__readerSchedulerStop?.()
      g.__readerSchedulerStop = null
      process.exit(0)
    })
  }
}
