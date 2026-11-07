/**
 * Scroll-into-view for keyboard and button navigation.
 *
 * Animated, but started synchronously: the motion is the browser's, not a
 * side-effect of the write that follows, so pressing Next moves the view at once
 * instead of after the server answers.
 *
 * While a scroll is in flight its destination is the reader's anchor — a card
 * that is animating past the reading band is not where the next press should
 * count from, or fast key repeat under-shoots.
 */
import type { EntryId } from '../shared/ids'

/** Short enough that a press lands before the eye gives up; long enough to read as motion. */
const DURATION_MS = 120

let rafId: number | null = null
let destination: EntryId | null = null

/** The card the current scroll is heading for, or null when at rest. */
export const navTarget = (): EntryId | null => destination

/**
 * The reading pane's scroll container.
 *
 * Resolved at use time, never in a ref: a ref callback runs before the element is
 * in the document, so ancestry is not available there. One definition, because
 * three (a query, a `closest()` climb and an `offsetParent` fallback) can each go
 * stale alone.
 */
export const scrollRoot = (): HTMLElement | null => {
  const el = document.querySelector<HTMLElement>('[data-testid="entry-scroll"]')
  return el ?? null
}

const scrollerFor = (el: HTMLElement): HTMLElement | null => scrollRoot() ?? el.parentElement

export const scrollToEntry = (entryId: EntryId): void => {
  const el = document.getElementById(`entry-${entryId}`)
  if (!el) return
  const scroller = scrollerFor(el)
  if (!scroller) return

  const from = scroller.scrollTop
  const to = from + (el.getBoundingClientRect().top - scroller.getBoundingClientRect().top)

  if (rafId != null) cancelAnimationFrame(rafId)
  destination = entryId

  const settle = (): void => {
    scroller.scrollTop = to
    rafId = null
    destination = null
  }

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduceMotion || Math.abs(to - from) < 1) {
    settle()
    return
  }

  const started = performance.now()
  const step = (now: number): void => {
    const progress = Math.min(1, (now - started) / DURATION_MS)
    // easeInOutQuad: no jerk at either end.
    const eased = progress < 0.5 ? 2 * progress * progress : 1 - (-2 * progress + 2) ** 2 / 2
    scroller.scrollTop = from + (to - from) * eased
    if (progress < 1) {
      rafId = requestAnimationFrame(step)
    } else {
      settle()
    }
  }
  rafId = requestAnimationFrame(step)
}
