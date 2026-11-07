/**
 * Reader state, per page render.
 *
 * Three mechanisms, and nothing else:
 *
 *  - **The list is a projection**, so the first document arrives with rows (the
 *    server awaits the read). Paging only appends: the derive receives the rows
 *    already on screen and asks for the missing page, so a row you have read
 *    cannot vanish from under you.
 *  - **Every mutation is an action with an optimistic guess.** The card and the
 *    sidebar show the expected value at once; the framework reverts the guess if
 *    the write is rejected and confirms it when the server's answer lands.
 *  - **The server's answer feeds the derive.** `markRead`, `markUnread` and
 *    `setStar` answer with the rows they wrote. The list's derive never re-reads
 *    them, so it re-produces from those answers and the winning guess is
 *    confirmed rather than discarded.
 */
import {
  action,
  createEffect,
  createMemo,
  createOptimisticStore,
  createSignal,
  createStore,
  refresh,
  snapshot,
  untrack,
} from 'solid-js'

import * as api from '../server/actions'
import { READ_LINE_FRACTION, clampNavIndex, shouldAutoRead } from '../shared/reading'
import { filterIdentity, hasView, type EntriesFilter } from '../shared/filter'
import type { CategoryId, EntryId, FeedId } from '../shared/ids'
import {
  DEFAULT_HIDE_EMPTY_FEEDS,
  DEFAULT_HIDE_READ_ITEMS,
  DEFAULT_SORT,
  DEFAULT_VIEW_MODE,
  type FeedPrefs,
} from '../shared/prefs'
import type { EntrySummary, FeedPanelResult, ViewCursor } from '../shared/types'
import { compareTitlesCI, computeUnreadCount } from '../shared/util'
import { navTarget, scrollRoot, scrollToEntry } from './nav'
import { checkVersion, updateAvailable } from './version'

/** One screenful; scrolling asks for another. */
const PAGE_SIZE = 100
const POLL_MS = 60_000
/** Must match the server's `entryIds` cap in `markRead` / `markUnread`. */
const WRITE_BATCH_MAX = 500

/** Split a write into calls the server accepts (its zod cap). */
const chunks = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

type ListState = {
  entries: EntrySummary[]
  nextCursor: ViewCursor | null
  /** Which view these rows belong to; a different one starts over. */
  viewKey: string
  /** Which generation of that view; a bump means re-read from the top. */
  gen: number
}

export type ReaderSession = {
  userHasScrolled: boolean
  atListEnd: boolean
  /** Rows you explicitly un-read this session: the scroll pass must not re-read them. */
  keepUnreadIds: EntryId[]
  expandedIds: EntryId[]
  viewModeOverride: 'expanded' | 'list' | null
  renameId: string | null
  renameKind: 'category' | null
  renameTitle: string
  /** Add or edit feed dialog; null = closed. One form for both operations. */
  feedForm: { mode: 'add' | 'edit'; feedId: FeedId | null } | null
  /**
   * Read state the server answered with, keyed by id, for the list's derive.
   *
   * The list's derive never re-reads a row, so a mutation's answer has to be an
   * input it can reproduce; otherwise the winning guess would be discarded at
   * commit and the row would flip back. Written only by mark-read / mark-unread.
   */
  serverReadStatus: Record<EntryId, 'read' | 'unread'>
  /** The same, for the star: written only by `setStar`. */
  serverStarred: Record<EntryId, boolean>
  /** Has navigation moved past the card the list opened on? */
  navStarted: boolean
  /** Rows to hold; grows as you scroll. */
  wanted: number
  /** Bumped to ask the list to start over from the newest row. */
  listGen: number
}

/** A rejection's status, whether it arrives as a Response or a wrapped error. */
const statusOf = (error: unknown): number | null => {
  if (error instanceof Response) return error.status
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : null
}

/** What to tell the reader when a write is rejected. */
export const describeWriteFailure = (
  error: unknown,
  what: string,
  options: { staleClient?: boolean } = {},
): string => {
  if (statusOf(error) === 401) return 'Your session expired. Sign in again to keep saving.'
  if (statusOf(error) === 403) return `You cannot ${what}.`
  // The server answered, so this is not a fault to diagnose: this document is
  // from an older build than the server and no longer speaks its protocol.
  // (Checked before the generic text because that text would blame the write.)
  if (options.staleClient) return `Could not ${what}. The reader was updated — reload to continue.`
  return `Could not ${what}. Nothing was saved.`
}

/** The RPC boundary takes JSON: hand it plain data, never a store proxy. */
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export const createReader = (filter: () => EntriesFilter) => {
  const [session, setSession] = createStore<ReaderSession>({
    userHasScrolled: false,
    atListEnd: false,
    keepUnreadIds: [],
    expandedIds: [],
    viewModeOverride: null,
    serverReadStatus: {},
    serverStarred: {},
    navStarted: false,
    renameId: null,
    renameKind: null,
    renameTitle: '',
    feedForm: null,
    wanted: PAGE_SIZE,
    listGen: 0,
  })

  const currentFeedId = (): FeedId | null => (filter().feedId as FeedId | undefined) ?? null

  /** The URL's view: the key the list's derive resets on. Declared before the
   *  projections, because hydration can run a derive while this body is still
   *  executing (a `const` below would be in its temporal dead zone). */
  const viewKey = createMemo(() => filterIdentity(filter()))

  // ---- server data ----
  /**
   * A page fetched ahead of the list.
   *
   * The derive must not be the one waiting on the network: an async derive holds
   * the frame it runs in until it lands, so a mark-read made while the next page
   * was in flight stayed un-grey for the whole round trip. `loadMore` fetches
   * outside the derive; the derive only consumes what is already here and so
   * stays synchronous after the first page.
   */
  let prefetched: { entries: EntrySummary[]; nextCursor: ViewCursor | null; from: string } | null =
    null
  let prefetching = false
  let prefetchToken = 0
  const cursorKey = (cursor: ViewCursor | null): string => (cursor ? JSON.stringify(cursor) : '')
  /** A reset (new view, re-read from the top) must not consume or block on an old page. */
  const resetPrefetch = (): void => {
    prefetchToken++
    prefetching = false
    prefetched = null
  }

  /**
   * The list, as a projection in its *draft* form: the derive receives what is
   * already on screen and appends only the page it does not have.
   */
  const [page, setPage] = createOptimisticStore<ListState>(
    async (draft) => {
      try {
        // Read tracked state BEFORE the first await: reads after one see the
        // snapshot taken when the compute started.
        const key = viewKey()
        const wanted = session.wanted
        const gen = session.listGen
        // Plain copies, taken before the first await: a store read after one sees
        // the snapshot from when the compute started.
        const serverReadStatus = { ...session.serverReadStatus }
        const serverStarred = { ...session.serverStarred }
        // No view (the home page) means no window to read: asking would be a
        // request for entries with no filter, which the server refuses.
        if (!hasView(filter())) {
          draft.viewKey = key
          draft.gen = gen
          draft.entries = []
          draft.nextCursor = null
          return
        }
        // A different view — or a request to re-read from the top — starts over.
        if (draft.viewKey !== key || draft.gen !== gen) {
          draft.viewKey = key
          draft.gen = gen
          draft.entries = []
          draft.nextCursor = null
        }
        // What the server answered for rows this session wrote. The derive never
        // re-reads them, so this is how it re-produces the write. Applied before
        // the first await: from there on the derive must not read the draft.
        for (const row of draft.entries) {
          const status = serverReadStatus[row.id]
          if (status) row.status = status
          if (row.id in serverStarred) row.starred = serverStarred[row.id]!
        }
        // The window's rows, and how many: read once, before the first await. The
        // draft's own keys are this derive's output, not dependencies, and a read
        // of them after an await is untracked state (UNTRACKED_READ_AFTER_AWAIT).
        const rows = draft.entries
        let count = rows.length
        let cursor = wire(draft.nextCursor)
        if (count === 0) {
          const first = await api.viewEntries(wire(filter()), null)
          draft.entries = snapshot(first.entries)
          draft.nextCursor = first.nextCursor
        } else {
          while (count < wanted && cursor) {
            const ahead = prefetched && prefetched.from === cursorKey(cursor) ? prefetched : null
            if (ahead) {
              prefetched = null
              rows.push(...snapshot(ahead.entries))
              draft.nextCursor = ahead.nextCursor
              cursor = wire(ahead.nextCursor)
              count += ahead.entries.length
              continue
            }
            const next = await api.viewEntries(wire(filter()), wire(cursor))
            rows.push(...snapshot(next.entries))
            draft.nextCursor = next.nextCursor
            cursor = wire(next.nextCursor)
            count += next.entries.length
          }
        }
      } catch (error) {
        // The list's half of the stale-client case: keep the rows on screen.
        if (await checkVersion()) return
        throw error
      }
    },
    { entries: [], nextCursor: null, viewKey: '', gen: 0 },
  )
  /**
   * The sidebar snapshot.
   *
   * A server function that no longer exists (a deploy under an open tab) answers
   * 409, which the RPC client throws as "not part of the deployment". Unhandled,
   * that escaped as an uncaught exception on every idle poll. Ask the version
   * endpoint instead: keep the snapshot already on screen and let the shell show
   * its reload notice. A read that fails for any other reason still throws.
   */
  let lastPanel: FeedPanelResult | null = null
  const [panel, setPanel] = createOptimisticStore<FeedPanelResult>(async () => {
    try {
      const next = await api.viewPanel(currentFeedId())
      lastPanel = next
      return next
    } catch (error) {
      if (lastPanel !== null && (await checkVersion())) return lastPanel
      throw error
    }
  }, null)

  const entries = (): EntrySummary[] => page.entries

  // ---- derived ----

  /**
   * This feed's saved preferences, resolved against the defaults.
   *
   * The controls read these, not `filter()`: the filter is the URL, and the URL
   * only names the view (`?feed=`), never the sort or hide-read prefs. Reading
   * `filter().sort` made the sort button compute from "oldest" forever and the
   * read-items button compute from "hidden" forever — one-way toggles whose label
   * disagreed with the window they had produced.
   */
  const feedPrefs = (): FeedPrefs | undefined => {
    const id = currentFeedId()
    return id ? panel.feedPrefs[id] : undefined
  }

  /** The resolved sort order this view is using. */
  const sortOrder = (): 'oldest' | 'newest' => feedPrefs()?.sort ?? DEFAULT_SORT

  /** Whether read entries are hidden in this view. */
  const hidesReadItems = (): boolean => feedPrefs()?.hideReadItems ?? DEFAULT_HIDE_READ_ITEMS

  const effectiveViewMode = (): 'expanded' | 'list' =>
    session.viewModeOverride ??
    (currentFeedId() ? panel.feedPrefs[currentFeedId()!]?.viewMode : undefined) ??
    DEFAULT_VIEW_MODE

  const currentTitle = (): string => {
    const active = filter()
    if (active.search) return `Search: ${active.search}`
    if (active.feedId) {
      const feed = panel.allFeeds.find((candidate) => candidate.id === active.feedId)
      return feed?.title ?? 'Feed'
    }
    if (active.starred) return 'Starred'
    return 'Home'
  }

  /** This feed's unread count, as the sidebar shows it. */
  const counterFor = (feedId: FeedId): number => panel.counters[feedId] ?? 0

  const unreadCount = (): number | null => {
    const active = filter()
    if (!active.feedId && !active.categoryId && !active.starred && !active.search) return null
    return computeUnreadCount(active, panel.feeds, panel.counters)
  }

  const favoriteFeeds = () =>
    panel.allFeeds
      .filter((feed) => panel.feedPrefs[feed.id]?.favorite === true)
      .sort((a, b) => compareTitlesCI(a.title, b.title))

  const favoriteFeedsWithUnread = () => favoriteFeeds().filter((feed) => counterFor(feed.id) > 0)

  const isFavorite = (feedId: FeedId): boolean => panel.feedPrefs[feedId]?.favorite === true

  /** Where this feed's icon can be fetched, or `null` for "show the letter". */
  const iconUrl = (feedId: FeedId): string | null => {
    const feed = panel.allFeeds.find((candidate) => candidate.id === feedId)
    return feed?.hasIcon ? `/api/icons/${feedId}` : null
  }

  // ---- writes ----

  const [writeError, setWriteError] = createSignal<string | null>(null)

  /**
   * Run a write. A rejection is reported; the optimistic guesses are already
   * back where they were, because those belong to the framework.
   *
   * A rejection that coincides with a different server build is a stale client,
   * not a failed write: say so, and let the shell offer the reload. Asking the
   * version endpoint costs one small request, and only on failure.
   */
  const runWrite = async (what: string, work: () => Promise<unknown>): Promise<boolean> => {
    try {
      await work()
      setWriteError(null)
      return true
    } catch (error) {
      const staleClient = await checkVersion()
      setWriteError(describeWriteFailure(error, what, { staleClient }))
      return false
    }
  }

  const dismissWriteError = (): void => {
    setWriteError(null)
  }

  /** The rows a mark would actually change: present, deduped, not already there. */
  const writable = (entryIds: EntryId[], status: 'read' | 'unread'): EntrySummary[] => {
    const seen = new Set<EntryId>()
    const rows: EntrySummary[] = []
    for (const id of entryIds) {
      if (seen.has(id)) continue
      seen.add(id)
      const entry = entries().find((candidate) => candidate.id === id)
      if (entry && entry.status !== status) rows.push(entry)
    }
    return rows
  }

  /** How a mark moves each affected feed's unread count. */
  const counterDeltas = (rows: EntrySummary[], delta: 1 | -1): Map<FeedId, number> => {
    const deltas = new Map<FeedId, number>()
    for (const row of rows) deltas.set(row.feedId, (deltas.get(row.feedId) ?? 0) + delta)
    return deltas
  }

  const guessReadStatus = (ids: Set<EntryId>, status: 'read' | 'unread'): void => {
    setPage((draft) => {
      for (const row of draft.entries) if (ids.has(row.id)) row.status = status
    })
  }

  const guessCounters = (deltas: Map<FeedId, number>): void => {
    setPanel((draft) => {
      for (const [feedId, delta] of deltas) {
        const next = (draft.counters[feedId] ?? 0) + delta
        draft.counters[feedId] = Math.max(0, next)
      }
    })
  }

  /**
   * Mark these read.
   *
   * The card and the sidebar move now. The server's answer lands inside the same
   * transaction, which is what makes the guesses confirmed rather than reverted:
   * the list's derive never re-reads a row, so the answer is how it reproduces
   * the write.
   */
  const markRead = (entryIds: EntryId[]): void => {
    const rows = writable(entryIds, 'read')
    if (rows.length === 0) return
    const ids = new Set(rows.map((row) => row.id))
    const deltas = counterDeltas(rows, -1)

    void runWrite('mark that read', () =>
      action(async function* () {
        guessReadStatus(ids, 'read')
        guessCounters(deltas)

        const written: Awaited<ReturnType<typeof api.markRead>> = []
        for (const chunk of chunks([...ids], WRITE_BATCH_MAX)) {
          written.push(...snapshot(yield api.markRead(chunk)))
        }
        setSession((draft) => {
          for (const row of written) draft.serverReadStatus[row.id] = row.status
        })
        yield Promise.all([refresh(page), refresh(panel)])
      })(),
    )
  }

  /** Mark these unread: the same shape, in the other direction. */
  const markUnread = (entryIds: EntryId[]): void => {
    const rows = writable(entryIds, 'unread')
    if (rows.length === 0) return
    const ids = new Set(rows.map((row) => row.id))
    const deltas = counterDeltas(rows, 1)

    void runWrite('mark that unread', () =>
      action(async function* () {
        guessReadStatus(ids, 'unread')
        guessCounters(deltas)

        const written: Awaited<ReturnType<typeof api.markUnread>> = []
        for (const chunk of chunks([...ids], WRITE_BATCH_MAX)) {
          written.push(...snapshot(yield api.markUnread(chunk)))
        }
        setSession((draft) => {
          for (const row of written) draft.serverReadStatus[row.id] = row.status
        })
        yield Promise.all([refresh(page), refresh(panel)])
      })(),
    )
  }

  const toggleRead = (entryId: EntryId): void => {
    const entry = entries().find((candidate) => candidate.id === entryId)
    if (!entry) return
    const next = entry.status === 'read' ? 'unread' : 'read'
    setSession((draft) => {
      if (next === 'unread' && !draft.keepUnreadIds.includes(entryId))
        draft.keepUnreadIds.push(entryId)
      if (next === 'read') draft.keepUnreadIds = draft.keepUnreadIds.filter((id) => id !== entryId)
    })
    if (next === 'read') markRead([entryId])
    else markUnread([entryId])
  }

  /**
   * May this entry be marked read automatically?
   *
   * The policy only; the caller decides what to do with the answer. The scroll
   * pass collects the ids that pass it into one call.
   */
  const canAutoRead = (
    entryId: EntryId,
    viaScroll = false,
    opts: { ignoreFeedSetting?: boolean; explicit?: boolean } = {},
  ): boolean => {
    // Never auto-read during a search — scrolling results shouldn't mark matches.
    if (filter().search) return false
    const entry = entries().find((candidate) => candidate.id === entryId)
    if (!entry || entry.status === 'read') return false
    const feedPrefs = currentFeedId() ? panel.feedPrefs[currentFeedId()!] : undefined
    return shouldAutoRead({
      viewMode: session.viewModeOverride ?? feedPrefs?.viewMode ?? DEFAULT_VIEW_MODE,
      userHasScrolled: viaScroll ? session.userHasScrolled : true,
      disabledAutoReadFeeds: (panel.userPrefs.disabledAutoReadFeeds ?? []) as FeedId[],
      keepUnreadIds: session.keepUnreadIds,
      feedId: entry.feedId,
      entryId,
      status: 'unread',
      ignoreFeedSetting: opts.ignoreFeedSetting,
      explicit: opts.explicit,
    })
  }

  const toggleExpanded = (entryId: EntryId): void => {
    if (session.expandedIds.includes(entryId)) {
      setSession((draft) => {
        draft.expandedIds = draft.expandedIds.filter((id) => id !== entryId)
      })
      return
    }
    setSession((draft) => {
      draft.expandedIds.push(entryId)
    })
    if (canAutoRead(entryId, false, { ignoreFeedSetting: true, explicit: true }))
      markRead([entryId])
  }

  /**
   * Index of the card at the top of the reading pane, read from the DOM.
   *
   * Geometry, not an observer: the same question j/k answers ("what am I looking
   * at?") and the same read line the scroll pass uses, so the keys and the pass
   * can never disagree about which card is current.
   */
  const anchorIndex = (): number => {
    const container = scrollRoot()
    const list = entries()
    if (!container) return 0
    const readLineY =
      container.getBoundingClientRect().top + container.clientHeight * READ_LINE_FRACTION
    for (let index = 0; index < list.length; index++) {
      const element = document.getElementById(`entry-${list[index]!.id}`)
      if (!element) continue
      if (element.getBoundingClientRect().bottom > readLineY) return index
    }
    return list.length - 1
  }

  /** The entry the keyboard acts on: whatever is at the band. */
  const currentEntryId = (): EntryId | null => entries()[anchorIndex()]?.id ?? null

  /**
   * Move the reading anchor (j/k and the prev/next buttons).
   *
   * The first press in a list *takes* the card you are looking at rather than
   * skipping past it: nothing is selected yet, so "next" means "start here".
   * Once you have scrolled or moved, the press moves by `delta` from the anchor.
   */
  const moveAndRead = (delta: 1 | -1): void => {
    const list = entries()
    if (list.length === 0) return
    const ids = list.map((entry) => entry.id)

    // During an animated scroll the destination is the anchor: the card drifting
    // past the band is not where the next press should count from.
    const target = navTarget()
    const targeted = target ? ids.indexOf(target) : -1
    const anchor = targeted >= 0 ? targeted : anchorIndex()

    const opened = !session.userHasScrolled && !session.navStarted
    const index = opened ? Math.max(0, anchor) : clampNavIndex(anchor + delta, ids.length)
    const nextId = ids[index]!

    // Started synchronously: this is a keyboard gesture, and the scroll must not
    // queue behind the write that follows it.
    scrollToEntry(nextId)
    setSession((draft) => {
      draft.navStarted = true
    })
    if (canAutoRead(nextId)) markRead([nextId])
  }

  const markDisplayed = (): void => {
    const unread = entries()
      .filter((entry) => entry.status !== 'read')
      .map((entry) => entry.id)
    markRead(unread)
  }

  const toggleStar = (entryId: EntryId): void => {
    const entry = entries().find((candidate) => candidate.id === entryId)
    if (!entry) return
    const next = !entry.starred
    const what = next ? 'star that' : 'unstar that'
    void runWrite(what, () =>
      action(async function* () {
        setPage((draft) => {
          const target = draft.entries.find((candidate) => candidate.id === entryId)
          if (target) target.starred = next
        })
        const written = snapshot(yield api.setStar(entryId, next))
        setSession((draft) => {
          for (const row of written) draft.serverStarred[row.id] = row.starred
        })
        yield refresh(page)
      })(),
    )
  }

  // ---- paging ----

  /**
   * Scroll further: fetch the next page now, and grow the window only once it is
   * here. Fetching inside the derive instead held the frame — and every mark-read
   * in it — until the page landed.
   */
  const loadMore = (): void => {
    const cursor = page.nextCursor
    if (!cursor) return
    // A page fetched for a tail that has since changed is useless.
    if (prefetched && prefetched.from !== cursorKey(cursor)) prefetched = null
    // Already fetched or fetching: nothing to ask for.
    if (prefetching || prefetched) return
    const token = prefetchToken
    prefetching = true
    void api.viewEntries(wire(filter()), wire(cursor)).then(
      (next) => {
        if (token !== prefetchToken) return
        prefetching = false
        prefetched = { entries: next.entries, nextCursor: next.nextCursor, from: cursorKey(cursor) }
        // Only now does the window grow, and the derive appends without waiting.
        setSession((draft) => {
          draft.wanted += PAGE_SIZE
        })
        refresh(page)
      },
      () => {
        if (token === prefetchToken) prefetching = false
      },
    )
  }

  const checkTail = (): void => {
    if (session.atListEnd) loadMore()
  }

  /**
   * Is this entry in the window? If not, ask for the next page.
   *
   * Used by scroll restoration: the saved anchor can sit past the first page,
   * or new entries can arrive above it while the tab is away. A row count is
   * not enough — the anchor is the target, so keep paging until it appears or
   * `nextCursor` runs out. `loadMore` is idempotent while a fetch is in flight,
   * so the restore loop can call this on every frame.
   */
  const ensureEntry = (entryId: EntryId): boolean =>
    // A one-shot query from the scroll-restore loop, not a dependency of the
    // page derive. It can run while that derive is mid-await on the first page.
    untrack(() => {
      if (entries().some((entry) => entry.id === entryId)) return true
      if (page.nextCursor) loadMore()
      return false
    })

  // A new view means a new list. Keyed on the URL filter (a string), not on the
  // projection's value: that would re-fire on every read and loop, because the
  // reset writes the projection's own inputs.
  createEffect(viewKey, () => {
    resetPrefetch()
    // The reader owns this page, and this page is gone. An error banner about a
    // write in the previous view is not news on a new one.
    setWriteError(null)
    setSession((draft) => {
      draft.userHasScrolled = false
      // Write only what changes: a fresh `[]` invalidates the list's derive,
      // which then reads a window for a view the reader has not opened.
      if (draft.keepUnreadIds.length > 0) draft.keepUnreadIds = []
      if (draft.expandedIds.length > 0) draft.expandedIds = []
      draft.viewModeOverride = null
      draft.wanted = PAGE_SIZE
      draft.atListEnd = false
      draft.serverReadStatus = {}
      draft.serverStarred = {}
      draft.navStarted = false
      draft.listGen = 0
    })
  })

  // ---- writes that change the view ----

  const setViewMode = (viewMode: 'expanded' | 'list'): void => {
    setSession((draft) => {
      draft.viewModeOverride = viewMode
    })
    const feedId = currentFeedId()
    if (!feedId) return
    void runWrite('save that preference', () =>
      action(function* () {
        setPanel((draft) => {
          draft.feedPrefs[feedId] = { ...draft.feedPrefs[feedId], viewMode }
        })
        yield api.setPrefs(feedId, { viewMode })
        // Re-produce the prefs, or the optimistic write above is discarded at
        // commit and the control snaps back.
        refresh(panel)
      })(),
    )
  }

  const setSort = (sort: 'oldest' | 'newest'): void => {
    const feedId = currentFeedId()
    if (!feedId) return
    void runWrite('save that sort order', () =>
      action(function* () {
        setPanel((draft) => {
          draft.feedPrefs[feedId] = { ...draft.feedPrefs[feedId], sort }
        })
        yield api.setPrefs(feedId, { sort })
        refresh(panel)
        refresh(page)
      })(),
    )
  }

  const setHideReadItems = (hideReadItems: boolean): void => {
    const feedId = currentFeedId()
    if (!feedId) return
    void runWrite('save that preference', () =>
      action(function* () {
        setPanel((draft) => {
          draft.feedPrefs[feedId] = { ...draft.feedPrefs[feedId], hideReadItems }
        })
        yield api.setPrefs(feedId, { hideReadItems })
        refresh(panel)
        refresh(page)
      })(),
    )
  }

  const toggleHideEmptyFeeds = (): void => {
    const next = !(panel.userPrefs.hideEmptyFeeds ?? DEFAULT_HIDE_EMPTY_FEEDS)
    void runWrite('save that preference', () =>
      action(function* () {
        setPanel((draft) => {
          draft.userPrefs = { ...draft.userPrefs, hideEmptyFeeds: next }
        })
        yield api.setPrefs(null, { hideEmptyFeeds: next })
        refresh(panel)
      })(),
    )
  }

  const toggleAutoRead = (feedId: FeedId): void => {
    const list = panel.userPrefs.disabledAutoReadFeeds ?? []
    const next = list.includes(feedId) ? list.filter((id) => id !== feedId) : [...list, feedId]
    void runWrite('save that preference', () =>
      action(function* () {
        setPanel((draft) => {
          draft.userPrefs = { ...draft.userPrefs, disabledAutoReadFeeds: next }
        })
        yield api.setPrefs(null, { disabledAutoReadFeeds: next })
        refresh(panel)
      })(),
    )
  }

  const toggleFavorite = (feedId: FeedId): void => {
    const next = !isFavorite(feedId)
    void runWrite('save that preference', () =>
      action(function* () {
        setPanel((draft) => {
          draft.feedPrefs[feedId] = { ...draft.feedPrefs[feedId], favorite: next }
        })
        yield api.setPrefs(feedId, { favorite: next })
        refresh(panel)
      })(),
    )
  }

  const openAddFeed = (): void => {
    setSession((draft) => {
      draft.feedForm = { mode: 'add', feedId: null }
    })
  }

  const openEditFeed = (feedId: FeedId): void => {
    setSession((draft) => {
      draft.feedForm = { mode: 'edit', feedId }
    })
  }

  const closeFeedForm = (): void => {
    setSession((draft) => {
      draft.feedForm = null
    })
  }

  const startRename = (id: string, title: string): void => {
    setSession((draft) => {
      draft.renameId = id
      draft.renameKind = 'category'
      draft.renameTitle = title
    })
  }

  const cancelRename = (): void => {
    setSession((draft) => {
      draft.renameId = null
      draft.renameKind = null
      draft.renameTitle = ''
    })
  }

  /** Edit the rename field; the draft lives in the session so both editors share it. */
  const setRenameTitle = (value: string): void => {
    setSession((draft) => {
      draft.renameTitle = value
    })
  }

  /**
   * Rename a folder: optimistic in the sidebar, then the server's copy. Feed
   * titles are edited in the feed form, not here.
   */
  const saveRename = async (): Promise<void> => {
    const id = session.renameId
    const title = session.renameTitle.trim()
    if (id == null || !title) return

    const saved = await runWrite('rename that folder', () =>
      action(function* () {
        // Applied inside the transition and re-produced by `refresh(panel)`.
        setPanel((draft) => {
          for (const category of draft.categories) if (category.id === id) category.title = title
        })
        yield api.renameCategory(id as CategoryId, title)
        refresh(panel)
      })(),
    )

    // The editor is session state, not a projection: close it only once the write
    // committed.
    if (saved) cancelRename()
  }

  const unsubscribe = async (feedId: FeedId): Promise<void> => {
    await runWrite('unsubscribe from that feed', async () => {
      await api.unsubscribe(feedId)
      refresh(panel)
      refresh(page)
    })
  }

  const refreshPanel = (): void => {
    refresh(panel)
  }

  /** Re-read the list from the top (a feed's URL changed, entries may differ). */
  const reloadList = (): void => {
    resetPrefetch()
    setSession((draft) => {
      draft.listGen++
      draft.serverReadStatus = {}
      draft.serverStarred = {}
    })
    refresh(page)
  }

  // ---- idle refresh ----

  let pollTimer: ReturnType<typeof setInterval> | undefined

  const stopIdleRefresh = (): void => {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = undefined
  }

  /**
   * Keep the sidebar honest on a long-lived tab.
   *
   * Polls the panel only. It used to reload the list as well when you had reached
   * the end, which replaced the rows under you: new entries arrive at the *top*,
   * so the window you were reading had to be pushed down or thrown away. The list
   * now changes only when you ask it to — navigate, scroll for more, or Refresh
   * feeds, which restarts it and takes you to the top.
   */
  const startIdleRefresh = (): (() => void) => {
    if (pollTimer) return stopIdleRefresh
    pollTimer = setInterval(() => {
      // A stale tab cannot read: every poll would 409 again. The reload notice is
      // already on screen, so stop asking until it is acted on.
      if (updateAvailable()) return
      refresh(panel)
    }, POLL_MS)
    return stopIdleRefresh
  }

  return {
    /** Identity of the current view. */
    viewKey,
    entries,
    counterFor,
    filter,
    page,
    setPage,
    panel,
    setPanel,
    session,
    setSession,
    currentTitle,
    unreadCount,
    effectiveViewMode,
    sortOrder,
    hidesReadItems,
    favoriteFeeds,
    favoriteFeedsWithUnread,
    isFavorite,
    iconUrl,
    toggleFavorite,
    toggleRead,
    toggleExpanded,
    canAutoRead,
    moveAndRead,
    currentEntryId,
    markDisplayed,
    markRead,
    markUnread,
    toggleStar,
    loadMore,
    checkTail,
    ensureEntry,
    refreshPanel,
    reloadList,
    setViewMode,
    setSort,
    setHideReadItems,
    toggleHideEmptyFeeds,
    toggleAutoRead,
    openAddFeed,
    openEditFeed,
    closeFeedForm,
    startRename,
    cancelRename,
    setRenameTitle,
    saveRename,
    writeError,
    dismissWriteError,
    unsubscribe,
    startIdleRefresh,
  }
}

export type Reader = ReturnType<typeof createReader>
