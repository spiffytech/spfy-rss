/**
 * Per-account preferences. Ported from the old prefs side-DB shape
 * (src/server/lib/prefs.ts of the previous app), extended with the v1
 * read-time filter lists (stored inside the feed-scope prefs JSON).
 *
 * Scopes: `user` (UserPrefs) and `feed:<uuid>` (FeedPrefs).
 */
import type { EntriesFilter } from './filter'
import type { FeedId } from './ids'

export type UserPrefs = {
  hideEmptyFeeds?: boolean
  disabledAutoReadFeeds?: FeedId[]
}

export type FeedPrefs = {
  viewMode?: 'expanded' | 'list'
  sort?: 'oldest' | 'newest'
  hideReadItems?: boolean
  /** Hand-picked: this feed's link appears on the home page. Orthogonal to
   *  category — a feed is favorited where it is, nothing moves. */
  favorite?: boolean
}

/** Hide feeds with nothing unread. The old app defaulted this to true
 *  (`ref(true)` + `hideEmptyFeeds ?? true`); an unset pref must not flip it. */
export const DEFAULT_HIDE_EMPTY_FEEDS = true

/** Global view defaults are hardcoded until a global preference UI exists. */
export const DEFAULT_VIEW_MODE = 'expanded' as const
export const DEFAULT_SORT = 'oldest' as const
export const DEFAULT_HIDE_READ_ITEMS = true

/** Reading time is surfaced only above this many minutes (strictly greater). */
export const READING_TIME_DISPLAY_MIN = 5

/**
 * Fold a feed's saved view prefs into a filter, falling back to the hardcoded
 * defaults. The bootstrap endpoint and the client both resolve through this so
 * the rows they show and the controls they render can't disagree.
 */
export function resolveViewFilter(
  filter: EntriesFilter,
  feedPrefs: Partial<Record<FeedId, FeedPrefs>> | undefined,
): EntriesFilter {
  const prefs = filter.feedId ? feedPrefs?.[filter.feedId as FeedId] : undefined
  return {
    ...filter,
    sort: prefs?.sort ?? DEFAULT_SORT,
    hideReadItems: prefs?.hideReadItems ?? DEFAULT_HIDE_READ_ITEMS,
  }
}

export function userScope(): string {
  return 'user'
}

export function feedScope(feedId: FeedId): string {
  return `feed:${feedId}`
}
