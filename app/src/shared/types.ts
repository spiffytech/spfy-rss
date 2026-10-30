/**
 * API shapes shared by the server and the client.
 */
import type { EntriesFilter } from './filter'
import type { CategoryId, EntryId, EntryStatus, EpochMs, FeedId } from './ids'
import type { FeedPrefs, UserPrefs } from './prefs'

/** The list row: everything the view renders except the entry body. */
export type EntrySummary = {
  id: EntryId
  feedId: FeedId
  feedTitle: string
  title: string
  url: string | null
  author: string | null
  publishedAt: EpochMs
  status: EntryStatus
  starred: boolean
  /**
   * The raw HTML body. It travels with the row rather than in a request of its
   * own: a page of a hundred averages 41 KB of bodies, less than the client
   * bundle, so splitting it out bought nothing and cost 100 requests per view.
   * The display pipeline still runs client-side (untrusted feed HTML).
   */
  content: string
  /** Feed base URL for resolving relative links inside the body. */
  feedBaseUrl: string | null
}

export type CategoryCount = {
  id: CategoryId
  title: string
}

export type FeedInfo = {
  id: FeedId
  /** Null = uncategorized. */
  categoryId: CategoryId | null
  title: string
  siteUrl: string | null
  feedUrl: string
  disabled: boolean
  parsingErrorCount: number
  /** Whether an icon exists. The URL is `/api/icons/<id>` — the client builds it. */
  hasIcon: boolean
}

export type FeedPanelResult = {
  /** Feeds the sidebar should show (empty ones may be hidden by preference). */
  feeds: FeedInfo[]
  /** Every feed, unfiltered — the home page resolves its favorites from here. */
  allFeeds: FeedInfo[]
  categories: CategoryCount[]
  /** Unread counts per feed — same filter predicate as the lists. */
  counters: Record<FeedId, number>
  /** Account-level preferences. Read by the same call, because the panel is what
   *  they act on (hide-empty) and the sidebar renders them. */
  userPrefs: UserPrefs
  /** Per-feed preferences (favourite, view mode, sort, hide-read). */
  feedPrefs: Record<FeedId, FeedPrefs>
}

/**
 * Outcome of adding or editing a feed. Failures are values, not thrown errors:
 * the RPC transport carries HTTP statuses but no messages, and the form needs
 * to say *why* a save failed.
 */
export type FeedSaveError =
  | 'invalid_url'
  | 'duplicate'
  | 'fetch'
  | 'parse'
  | 'folder'
  | 'not_found'

export type FeedSaveResult =
  | { ok: true; feedId: FeedId; urlChanged: boolean }
  | { ok: false; reason: FeedSaveError; detail?: string; feedId?: FeedId }

export type OpmlImportResult =
  | { ok: true; imported: number; existing: number; invalid: number }
  | { ok: false; reason: 'invalid_file' | 'too_large' }

export type EntriesResult = {
  entries: EntrySummary[]
  /** Keyset cursor into (published_at, id); null = end of the view. */
  nextCursor: ViewCursor | null
}

/** Keyset cursor into (published_at, id). `bucket` is present only for
 *  search views, whose ordering is unread-first (0 = unread, 1 = read). */
export type ViewCursor = { publishedAt: EpochMs; id: EntryId; bucket?: 0 | 1 }

