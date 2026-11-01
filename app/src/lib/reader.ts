/**
 * Reader state, per page render.
 *
 * Three mechanisms, and nothing else:
 *
 *  - **The list is a projection**, so the first document arrives with rows (the
 *    server awaits the read) and a write can be applied optimistically.
 *  - **Paging only appends.** The derive receives the rows already on screen and
 *    asks for the missing page; `refresh` therefore never disturbs what you are
 *    reading, and a row you have read cannot vanish from under you.
 *  - **A write applies the server's copy of the rows it touched.** `setStatus`
 *    answers with them, so a mark-read costs no re-read of the window — no
 *    dirty-id bookkeeping, no reconciliation pass.
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
} from 'solid-js'

import * as api from '../server/actions'
import { BAND_FRACTION, clampNavIndex, shouldAutoRead } from '../shared/reading'
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

/** One screenful; scrolling asks for another. */
const PAGE_SIZE = 100
const POLL_MS = 60_000
/** Must match the server's `entryIds` cap in `setStatus`. */
const STATUS_BATCH_MAX = 500

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
  /** Rows you explicitly un-read this session: the scroll sweep must not re-read them. */
  keepUnreadIds: EntryId[]
  expandedIds: EntryId[]
  viewModeOverride: 'expanded' | 'list' | null
  renameId: string | null
  renameKind: 'category' | null
  renameTitle: string
  /** Add or edit feed dialog; null = closed. One form for both operations. */
  feedForm: { mode: 'add' | 'edit'; feedId: FeedId | null } | null
  /**
   * What the server said about rows this session has written, keyed by id.
   *
   * This is not a copy of the list: it is the only way the list's derive can
   * produce the truth about a row it never re-reads (the derive appends pages and
   * leaves existing rows alone). Without it a mark-read flips optimistically and
   * then reverts at commit, while the database has it right — silent divergence.
   * Only the two fields a write changes are kept.
   */
  confirmed: Record<EntryId, { status: 'read' | 'unread'; starred: boolean }>
  /** Has navigation moved past the card the list opened on? */
  navStarted: boolean
  /**
   * A local answer for a feed's unread count, and the server number it was based
   * on. Used only while the server still reports that number: as soon as its count
   * differs, the count is the server's again. That is what makes marking entries
   * read move the sidebar at once without a cache to invalidate.
   */
  counterGuess: Record<FeedId, { basedOn: number; value: number }>
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
export const describeWriteFailure = (error: unknown, what: string): string => {
  if (statusOf(error) === 401) return 'Your session expired. Sign in again to keep saving.'
  if (statusOf(error) === 403) return `You cannot ${what}.`
  return `Could not ${what}. The list has been refreshed.`
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
    confirmed: {},
    counterGuess: {},
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
   * The list, as a projection in its *draft* form: the derive receives what is
   * already on screen and appends only the page it does not have.
   */
  const [page, setPage] = createOptimisticStore<ListState>(
    async (draft) => {
      // Read tracked state BEFORE the first await: reads after one see the
      // snapshot taken when the compute started.
      const key = viewKey()
      const wanted = session.wanted
      const gen = session.listGen
      // A plain copy, taken before the first await: a store read after one sees
      // the snapshot from when the compute started.
      const confirmed = { ...session.confirmed }
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
      if (draft.entries.length === 0) {
        const first = await api.viewEntries(wire(filter()), null)
        draft.entries = snapshot(first.entries)
        draft.nextCursor = first.nextCursor
      } else {
        while (draft.entries.length < wanted && draft.nextCursor) {
          const next = await api.viewEntries(wire(filter()), wire(draft.nextCursor))
          draft.entries.push(...snapshot(next.entries))
          draft.nextCursor = next.nextCursor
        }
      }
      // What this session's writes changed, per row.
      const written = Object.values(confirmed)
      if (written.length > 0) {
        const byId = new Map(
          Object.entries(confirmed).map(([id, patch]) => [id as EntryId, patch]),
        )
        for (const row of draft.entries) {
          const patch = byId.get(row.id)
          if (!patch) continue
          row.status = patch.status
          row.starred = patch.starred
        }
      }
    },
    { entries: [], nextCursor: null, viewKey: '', gen: 0 },
  )
  const [panel, setPanel] = createOptimisticStore<FeedPanelResult>(
    () => api.viewPanel(currentFeedId()),
    null,
  )

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

  /** This feed's unread count: the server's, unless a local guess is still fresh. */
  const counterFor = (feedId: FeedId): number => {
    const server = panel.counters[feedId] ?? 0
    const guess = session.counterGuess[feedId]
    return guess && guess.basedOn === server ? guess.value : server
  }

  /** All counters with local guesses applied, for callers that sum several feeds. */
  const counters = (): Record<string, number> => {
    const server = panel.counters
    if (Object.keys(session.counterGuess).length === 0) return server
    const merged: Record<string, number> = { ...server }
    for (const feed of panel.feeds) merged[feed.id] = counterFor(feed.id)
    return merged
  }

  const unreadCount = (): number | null => {
    const active = filter()
    if (!active.feedId && !active.categoryId && !active.starred && !active.search) return null
    return computeUnreadCount(active, panel.feeds, counters())
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
   * Run a write and, if it is rejected, say so and put the screen back on truth.
   *
   * There is no compensation to write: the framework already discarded the
   * optimistic layer, so all that is left is telling the reader what happened and
   * re-reading — which is also what clears a stale row from the list.
   */
  const runWrite = async (what: string, work: () => Promise<unknown>): Promise<boolean> => {
    try {
      await work()
      setWriteError(null)
      return true
    } catch (error) {
      setWriteError(describeWriteFailure(error, what))
      setSession((draft) => {
        draft.counterGuess = {}
      })
      refresh(page)
      refresh(panel)
      return false
    }
  }

  const dismissWriteError = (): void => {
    setWriteError(null)
  }

  /**
   * Record what a write changed, then let the list re-produce itself.
   *
   * A projection's value at commit comes from its derive, not from the write, so
   * the derive has to be able to produce the truth. With the rows already on
   * screen it fetches nothing, so this reconciles without a read.
   */
  const confirm = (writes: { id: EntryId; status: 'read' | 'unread'; starred: boolean }[]): void => {
    setSession((draft) => {
      for (const write of writes) draft.confirmed[write.id] = { status: write.status, starred: write.starred }
    })
    refresh(page)
  }

  /**
   * Read marks waiting to be sent.
   *
   * A scroll sweep marks several entries in one frame, so they travel together —
   * but only until the end of the tick they were marked in, not on a timer. Nothing
   * is ever held: by the time the browser paints, the request is already out.
   */
  const pending = new Map<EntryId, 'read' | 'unread'>()
  let flushQueued = false

  const flushStatus = (): void => {
    flushQueued = false
    if (pending.size === 0) return
    const batch = [...pending]
    const reads: EntryId[] = []
    const unreads: EntryId[] = []
    for (const [id, status] of batch) (status === 'read' ? reads : unreads).push(id)
    pending.clear()

    void runWrite(reads.length > 0 ? 'mark that read' : 'mark that unread', async () => {
      // The server answers with the rows it wrote: remember what it changed, then
      // let the list re-produce itself from that.
      // The endpoint accepts 500 ids per call. Mark-all on a long scroll can hold
      // more than that, and used to fail the whole batch with a 400.
      const chunks = <T>(items: T[]): T[][] => {
        const out: T[][] = []
        for (let i = 0; i < items.length; i += STATUS_BATCH_MAX) {
          out.push(items.slice(i, i + STATUS_BATCH_MAX))
        }
        return out
      }
      const rows = await action(function* () {
        const written: Awaited<ReturnType<typeof api.setStatus>> = []
        for (const chunk of chunks(reads)) written.push(...snapshot(yield api.setStatus(chunk, 'read')))
        for (const chunk of chunks(unreads)) {
          written.push(...snapshot(yield api.setStatus(chunk, 'unread')))
        }
        return written
      })()
      confirm(
        rows
          .filter((row) => row.status === "read" || row.status === "unread")
          .map((row) => ({ id: row.id, status: row.status as "read" | "unread", starred: row.starred })),
      )
      // One re-read per burst (the batch is already coalesced), so the sidebar
      // settles on the server's numbers as soon as the write comes back — which is
      // also what expires the local guesses.
      refresh(panel)
    })
  }

  /**
   * Mark entries read (or unread): visible at once, sent once per burst.
   *
   * The visible part is a write to `confirmed` plus a refresh, which is *not* an
   * optimistic write — it is the value the derive produces, so it survives. (A
   * projection write here, outside any action, has no transaction to live in and
   * is discarded: that is why the row used to grey out only when the batch came
   * back.)
   */
  const setStatus = (entryIds: EntryId[], status: 'read' | 'unread'): void => {
    if (entryIds.length === 0) return
    const writes: { id: EntryId; status: 'read' | 'unread'; starred: boolean }[] = []
    const deltas = new Map<FeedId, number>()
    for (const entryId of entryIds) {
      const entry = entries().find((candidate) => candidate.id === entryId)
      if (!entry || entry.status === status) continue
      writes.push({ id: entryId, status, starred: entry.starred })
      deltas.set(entry.feedId, (deltas.get(entry.feedId) ?? 0) + (status === 'read' ? -1 : 1))
      pending.set(entryId, status)
    }
    if (writes.length === 0) return
    // The sidebar follows the same click, as a guess tied to the number it was
    // based on (see counterGuess). Accumulated per feed and read back from this
    // draft, because several marks land in one tick and each has to build on the
    // last: reading the store here would see the value from before the tick.
    setSession((draft) => {
      for (const [feedId, delta] of deltas) {
        const basedOn = panel.counters[feedId] ?? 0
        const current = draft.counterGuess[feedId]
        const base = current && current.basedOn === basedOn ? current.value : basedOn
        draft.counterGuess = {
          ...draft.counterGuess,
          [feedId]: { basedOn, value: Math.max(0, base + delta) },
        }
      }
    })
    confirm(writes)
    if (!flushQueued) {
      flushQueued = true
      queueMicrotask(flushStatus)
    }
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
    setStatus([entryId], next)
  }

  const autoRead = (
    entryId: EntryId,
    viaScroll = false,
    opts: { ignoreFeedSetting?: boolean; explicit?: boolean } = {},
  ): void => {
    // Never auto-read during a search — scrolling results shouldn't mark matches.
    if (filter().search) return
    const entry = entries().find((candidate) => candidate.id === entryId)
    if (!entry || entry.status === 'read') return
    const feedPrefs = currentFeedId() ? panel.feedPrefs[currentFeedId()!] : undefined
    if (
      !shouldAutoRead({
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
    ) {
      return
    }
    setStatus([entryId], 'read')
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
    autoRead(entryId, false, { ignoreFeedSetting: true, explicit: true })
  }

  /**
   * Index of the card at the top of the reading band, read from the DOM.
   *
   * Geometry, not an observer: the same question j/k answers ("what am I looking
   * at?") and the same line the scroll sweep uses, so the keys and the sweep can
   * never disagree about which card is current.
   */
  const anchorIndex = (): number => {
    const container = scrollRoot()
    const list = entries()
    if (!container) return 0
    const bandTop = container.getBoundingClientRect().top + container.clientHeight * BAND_FRACTION
    for (let index = 0; index < list.length; index++) {
      const element = document.getElementById(`entry-${list[index]!.id}`)
      if (!element) continue
      if (element.getBoundingClientRect().bottom > bandTop) return index
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
    autoRead(nextId)
  }

  const markDisplayed = (): void => {
    const unread = entries()
      .filter((entry) => entry.status !== 'read')
      .map((entry) => entry.id)
    setStatus(unread, 'read')
  }

  const toggleStar = (entryId: EntryId): void => {
    const entry = entries().find((candidate) => candidate.id === entryId)
    if (!entry) return
    const next = !entry.starred
    const what = next ? 'star that' : 'unstar that'
    void runWrite(what, async () => {
      const rows = await action(function* () {
        setPage((draft) => {
          const target = draft.entries.find((candidate) => candidate.id === entryId)
          if (target) target.starred = next
        })
        return snapshot(yield api.setStarred([entryId], next))
      })()
      confirm(rows)
    })
  }

  // ---- paging ----

  /** Scroll further: the derive appends one more page. */
  const loadMore = (): void => {
    if (!page.nextCursor) return
    setSession((draft) => {
      draft.wanted += PAGE_SIZE
    })
    refresh(page)
  }

  const checkTail = (): void => {
    if (session.atListEnd) loadMore()
  }

  /**
   * Grow the window to at least `count` rows.
   *
   * Used by scroll restoration: a saved position can sit past the first page,
   * which is all a fresh load (or a restored tab) has in hand.
   */
  const ensureWindow = (count: number): void => {
    if (count <= session.wanted) return
    setSession((draft) => {
      draft.wanted = count
    })
    refresh(page)
  }

  // A new view means a new list. Keyed on the URL filter (a string), not on the
  // projection's value: that would re-fire on every read and loop, because the
  // reset writes the projection's own inputs.
  createEffect(viewKey, () => {
    setSession((draft) => {
      draft.userHasScrolled = false
      // Write only what changes: a fresh `[]` invalidates the list's derive,
      // which then reads a window for a view the reader has not opened.
      if (draft.keepUnreadIds.length > 0) draft.keepUnreadIds = []
      if (draft.expandedIds.length > 0) draft.expandedIds = []
      draft.viewModeOverride = null
      draft.wanted = PAGE_SIZE
      draft.atListEnd = false
      draft.confirmed = {}
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
    setSession((draft) => {
      draft.listGen++
      draft.confirmed = {}
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
    pollTimer = setInterval(() => refresh(panel), POLL_MS)
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
    autoRead,
    moveAndRead,
    currentEntryId,
    markDisplayed,
    setStatus,
    toggleStar,
    loadMore,
    checkTail,
    ensureWindow,
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
