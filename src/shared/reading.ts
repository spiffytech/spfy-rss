// Pure reading-pane decision logic — DOM-free so it is unit-testable under
// `bun test`. `src/lib/reader.ts` wires it to real scrolling.

import type { EntryId, FeedId } from './ids'

export interface TrackedRect {
  top: number
  bottom: number
}

/**
 * Where the read line sits, as a fraction of the scroll container's height from
 * its top. One constant for both users: the scroll pass (what did I scroll
 * past?) and the keyboard anchor (what am I looking at?).
 */
export const READ_LINE_FRACTION = 0.15

/**
 * Auto-read guard: should the scroll-driven auto-read fire for this entry?
 *   $userHasScrolled && !$disabledAutoReadFeeds.includes(feed_id)
 *     && !$keepUnreadIds.includes(id)
 * (the entry must also be unread — the server re-checks as a second line of
 * defense, but the client shouldn't fire the request for read entries).
 */
export function shouldAutoRead(opts: {
  viewMode: 'expanded' | 'list'
  userHasScrolled: boolean
  disabledAutoReadFeeds: readonly FeedId[]
  keepUnreadIds: readonly EntryId[]
  feedId: FeedId
  entryId: EntryId
  status: 'read' | 'unread'
  /**
   * Card clicks mark read even when the feed has mark-read-on-scroll
   * disabled: the setting governs passive marking; an explicit click on the
   * entry is a deliberate "I'm through with this".
   */
  ignoreFeedSetting?: boolean
  /**
   * A direct human action (clicking the entry to expand it) reads even in
   * list view, where collapsed content normally keeps auto-read off.
   * Bypasses only the view-mode gate, not the keep-unread/feed guards.
   */
  explicit?: boolean
}): boolean {
  return (
    (opts.explicit || opts.viewMode === 'expanded') &&
    opts.userHasScrolled &&
    (opts.ignoreFeedSetting || !opts.disabledAutoReadFeeds.includes(opts.feedId)) &&
    !opts.keepUnreadIds.includes(opts.entryId) &&
    opts.status === 'unread'
  )
}

/**
 * Has the card's top edge risen above the read line (given in the same
 * coordinate space as the rect)? The test is absolute — every card, short or
 * tall, passes the line after the same amount of scrolling, because it is the
 * top edge, not the bottom. A pure state test also can't miss a card the way
 * transition observers can (mounts straddling the line, crossings completed
 * between evaluations): if its top is above the line, the user scrolled past it.
 */
export function isPastReadLine(rect: TrackedRect, readLineY: number): boolean {
  return rect.top < readLineY
}

/** Clamp a nav index into [0, length-1]; 0 when the list is empty. */
export function clampNavIndex(index: number, length: number): number {
  if (length <= 0) return 0
  return Math.max(0, Math.min(length - 1, index))
}
