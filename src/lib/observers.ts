/**
 * Reading-pane observers: the scroll pass (mark what you scrolled past as read)
 * and the end-of-list sentinel.
 *
 * Browser-only, and per page: they read and write the page's reader, which is
 * passed in rather than imported, so nothing here depends on ambient state.
 *
 * There is deliberately **no** IntersectionObserver tracking "the card at the
 * top": that question is answered from geometry when it is asked (see
 * `anchorIndex` in the reader), because an observer's report lags a fast or
 * programmatic scroll, and a stale answer made Prev/Next move relative to a card
 * that had already left the screen.
 */
import { READ_LINE_FRACTION, isPastReadLine } from '../shared/reading'
import type { EntryId } from '../shared/ids'
import { scrollRoot } from './nav'
import type { Reader } from './reader'

type TrackedCard = { el: HTMLElement; entryId: EntryId }

const cards = new Set<TrackedCard>()
let frame: number | null = null

/** The reading pane's scroll container, from the one definition in ./nav. */
const scrollContainer = (): HTMLElement | null => scrollRoot()

/**
 * One pass over the tracked cards: every card whose top edge is above the read
 * line was scrolled past, so it is marked read.
 *
 * The pass is one animation frame, and one call: the cards it finds travel
 * together as a single mark-read. Coalescing to the frame is what keeps a fast
 * scroll from sending a request per card.
 */
export const markScrolledPastRead = (r: Reader): void => {
  if (frame != null) return
  frame = requestAnimationFrame(() => {
    frame = null
    // canAutoRead owns the full guard; this is just the cheapest pre-check.
    if (!r.session.userHasScrolled) return
    const container = scrollContainer()
    if (!container) return
    const rect = container.getBoundingClientRect()
    const readLineY = rect.top + rect.height * READ_LINE_FRACTION
    const scrolledPast: EntryId[] = []
    for (const card of [...cards]) {
      if (!card.el.isConnected) {
        cards.delete(card)
      } else if (isPastReadLine(card.el.getBoundingClientRect(), readLineY)) {
        cards.delete(card)
        if (r.canAutoRead(card.entryId, true)) scrolledPast.push(card.entryId)
      }
    }
    if (scrolledPast.length > 0) r.markRead(scrolledPast)
  })
}

/**
 * The one scroll listener for the reading pane: it arms the pass, records
 * end-of-list (which gates the idle-time tail recheck) and asks for a pass.
 * Capture on the document, because a scroll event does not bubble.
 *
 * Returns the cleanup.
 */
export const watchScroll = (r: Reader): (() => void) => {
  const onScroll = (): void => {
    const container = scrollContainer()
    if (!container) return
    // A scroll landing at scrollTop 0 is our own programmatic reset when a fresh
    // list replaces the old one — not user intent. Without this, opening a feed
    // arms the auto-read pass and marks its first entry read.
    const scrolled = container.scrollTop !== 0
    const atEnd = container.scrollTop + container.clientHeight >= container.scrollHeight - 200
    r.setSession((draft) => {
      if (scrolled) draft.userHasScrolled = true
      draft.atListEnd = atEnd
    })
    if (scrolled) markScrolledPastRead(r)
  }
  document.addEventListener('scroll', onScroll, { capture: true, passive: true })
  return () => document.removeEventListener('scroll', onScroll, { capture: true })
}

/**
 * Track one entry card for the scroll pass. Call from a `ref` callback; the
 * returned function is the cleanup.
 */
export const trackCard = (node: HTMLElement, entryId: EntryId): (() => void) => {
  const card: TrackedCard = { el: node, entryId }
  cards.add(card)
  return () => {
    cards.delete(card)
  }
}

/**
 * Scroll sentinel for windowed views: fires on every intersection including the
 * initial mount report, so an under-filled viewport immediately pulls the next
 * window. The caller guards with `nextCursor && !loadingMore`.
 */
export const observeSentinel = (
  node: HTMLElement,
  fire: () => void | Promise<void>,
): (() => void) => {
  const sentinel = new IntersectionObserver(
    (batch) => {
      for (const item of batch) if (item.isIntersecting) void fire()
    },
    { root: scrollContainer(), rootMargin: '0px 0px 400px 0px', threshold: 0 },
  )
  sentinel.observe(node)
  return () => sentinel.disconnect()
}

/**
 * Focus an element the moment it mounts (rename editors).
 *
 * Deferred by a microtask: a ref callback runs while the element is still being
 * inserted, and an element that is not yet in the document cannot take focus.
 */
export const autofocus = (node: HTMLElement): void => {
  queueMicrotask(() => node.focus())
}
