/**
 * Mobile drawer gestures: a horizontal swipe across the reading pane opens the
 * sidebar; a swipe the other way closes it.
 *
 * Detection only — the browser keeps its own scrolling and selection behavior.
 * The guards exist so the gesture never steals an interaction that already
 * means something: text selection, horizontal scrolling inside a code block,
 * dragging from a form control, or a vertical scroll that starts crooked.
 *
 * Deliberately not edge-anchored: Android and iOS reserve the screen edges for
 * the system back gesture, so a swipe that had to start at x = 0 would often
 * never reach the page at all.
 *
 * Returns a cleanup function; call it from the `onSettled` cleanup.
 */

const MIN_SWIPE = 64
/** Vertical drift allowed, as a fraction of the horizontal distance. */
const MAX_VERTICAL_RATIO = 0.6
/** Vertical drift this large before the swipe commits means "scrolling". */
const VERTICAL_ESCAPE = 16
const IGNORE_SELECTOR = 'input, textarea, select, [contenteditable="true"]'

/**
 * The app's own vertical scrollers. Their computed `overflow-x` is `auto`
 * because the other axis scrolls, and one wide image must not turn the whole
 * pane into a gesture dead zone — so the walk for a horizontal scroller stops
 * at these. Anything closer to the target (a `<pre>`, a wide table) still
 * counts.
 */
const SCROLL_BOUNDARY = '[data-testid="entry-scroll"], .app-sidebar'

/** +1 for a rightward swipe, -1 for leftward, 0 when the drag is not one. */
export const swipeDirection = (dx: number, dy: number, minDistance = MIN_SWIPE): -1 | 0 | 1 => {
  if (Math.abs(dx) < minDistance) return 0
  if (Math.abs(dy) > Math.abs(dx) * MAX_VERTICAL_RATIO) return 0
  return dx > 0 ? 1 : -1
}

/** True when the target sits inside something that scrolls sideways itself. */
const horizontallyScrollable = (target: EventTarget | null): boolean => {
  let node = target instanceof Element ? target : null
  while (node) {
    if (node.matches(SCROLL_BOUNDARY)) return false
    const overflowX = getComputedStyle(node).overflowX
    if ((overflowX === 'auto' || overflowX === 'scroll') && node.scrollWidth > node.clientWidth) {
      return true
    }
    node = node.parentElement
  }
  return false
}

const hasSelection = (): boolean => {
  const selection = window.getSelection()
  return selection !== null && selection.toString() !== ''
}

export const attachSwipe = (handlers: {
  onSwipeRight: () => void
  onSwipeLeft: () => void
}): (() => void) => {
  let start: { x: number; y: number } | null = null
  let aborted = false
  /**
   * Some pointer types still emit a click after a drag. Left alone, that click
   * lands on the scrim the swipe just revealed and immediately closes the
   * drawer again. One click is swallowed, and the next pointerdown clears the
   * flag in case the browser never sent one (touch drags usually don't).
   */
  let swallowClick = false

  const reset = () => {
    start = null
    aborted = false
  }

  const onPointerDown = (event: PointerEvent) => {
    reset()
    swallowClick = false
    if (event.button !== 0 || event.isPrimary === false) return
    const target = event.target
    if (target instanceof Element && target.closest(IGNORE_SELECTOR)) return
    if (horizontallyScrollable(target)) return
    start = { x: event.clientX, y: event.clientY }
  }

  const onPointerMove = (event: PointerEvent) => {
    if (!start || aborted) return
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    if (Math.abs(dy) > VERTICAL_ESCAPE && Math.abs(dy) > Math.abs(dx)) aborted = true
  }

  const onPointerUp = (event: PointerEvent) => {
    if (!start || aborted) return reset()
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    reset()
    // A long press followed by a drag selects text; that is not a drawer swipe.
    if (hasSelection()) return
    const direction = swipeDirection(dx, dy)
    if (direction === 0) return
    swallowClick = true
    if (direction > 0) handlers.onSwipeRight()
    else handlers.onSwipeLeft()
  }

  const onClick = (event: MouseEvent) => {
    if (!swallowClick) return
    swallowClick = false
    event.preventDefault()
    event.stopPropagation()
  }

  window.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', reset)
  window.addEventListener('click', onClick, true)
  return () => {
    window.removeEventListener('pointerdown', onPointerDown)
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointercancel', reset)
    window.removeEventListener('click', onClick, true)
  }
}
