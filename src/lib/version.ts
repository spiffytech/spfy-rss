/**
 * Detecting a stale client, and nothing else.
 *
 * A deploy does not reload the tabs and installed PWAs already open: their
 * module graph keeps running, and the first sign of trouble is a write whose
 * server function no longer exists. This module answers one question — "did the
 * server in front of me come from a different build than I did?" — and lets the
 * shell say so. It never reloads anything and never blocks a request.
 *
 * `updateAvailable` is app-wide (module scope, not page scope) so navigation
 * cannot strand it; it is only ever written in the browser, never during SSR.
 */
import { createSignal } from 'solid-js'

import { BUILD_ID } from '../shared/build'

const [updateAvailable, setUpdateAvailable] = createSignal(false)

export { updateAvailable }

let inFlight: Promise<boolean> | null = null

const fetchBuildId = async (): Promise<string | null> => {
  try {
    const response = await fetch('/api/version', { cache: 'no-store' })
    if (!response.ok) return null
    const body = (await response.json()) as { buildId?: unknown }
    return typeof body.buildId === 'string' ? body.buildId : null
  } catch {
    // An unreachable server is not evidence of skew; the write's own failure is
    // reported by the write.
    return null
  }
}

/**
 * Ask the server which build it is. Resolves to whether this client is behind.
 * Coalesced: a burst of failed writes asks once.
 */
export const checkVersion = (): Promise<boolean> => {
  if (!inFlight) {
    inFlight = fetchBuildId()
      .then((serverBuild) => {
        const behind = serverBuild !== null && serverBuild !== BUILD_ID
        if (behind) setUpdateAvailable(true)
        return behind
      })
      .finally(() => {
        inFlight = null
      })
  }
  return inFlight
}

/**
 * The app-wide watch: one check at mount, and one every time the document comes
 * back to the foreground — the resume path an installed PWA actually takes.
 * Returns the cleanup.
 */
export const watchVersion = (): (() => void) => {
  void checkVersion()
  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') void checkVersion()
  }
  document.addEventListener('visibilitychange', onVisibility)
  return () => document.removeEventListener('visibilitychange', onVisibility)
}
