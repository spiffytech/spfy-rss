/**
 * Redact anything shaped like `scheme://user:pass@host` before it leaves the
 * box. Over-redacting is the right trade. Ported verbatim from the retired app.
 */
function scrub(s: string): string {
  return s.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s@]+@/gi, '$1[redacted]@')
}

/**
 * ntfy alert posting. Best-effort: never throws, never hangs the loop —
 * a short timeout and a swallowed error are exactly what we want here.
 */
export async function notify(url: string, title: string, message: string): Promise<void> {
  if (!url) return // empty URL = alerts disabled
  try {
    await fetch(url, {
      method: 'POST',
      headers: { Title: title },
      body: scrub(message),
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    // Alerts are advisory. Losing one must not take down the scheduler.
  }
}
