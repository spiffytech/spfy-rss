import { Show, createMemo, createSignal, onSettled } from 'solid-js'
import { useNavigate, useSearchParams } from '@solidjs/router'

import type { FeedId } from '../shared/ids'
import { computePopoverPlacement } from '../shared/popover'
import { DEFAULT_HIDE_EMPTY_FEEDS } from '../shared/prefs'
import { createSearch } from '../lib/search'
import { clearScrollMemory } from '../lib/scroll-memory'
import * as api from '../server/actions'
import { useReader } from '../lib/reader-context'

const PANEL_ID = 'feed-menu'

/**
 * The toolbar's "where am I" label turned into a menu: the current feed's name
 * and unread count, plus a popover holding everything you can do to this view.
 *
 * The panel is a modal <dialog>, which buys light dismiss (via backdrop tap),
 * Escape, focus restoration and immunity to ancestor overflow/clipping for free.
 * Position comes from computePopoverPlacement, applied before showModal() so it
 * can never paint a frame in the UA's default centred position.
 *
 * Row styling follows Refactoring UI's action hierarchy: one primary (solid
 * accent), secondary actions as lower-contrast fills with no border, and the
 * destructive action demoted to that same secondary weight — the loud red is
 * reserved for the confirm() step. Rows are always filled rather than filled on
 * hover, because hover does not exist on a touchscreen.
 */
export const FeedMenu = () => {
  const r = useReader()
  const {
    currentTitle,
    effectiveViewMode,
    isFavorite,
    markDisplayed,
    openEditFeed,
    setHideReadItems,
    setSort,
    setViewMode,
    toggleAutoRead,
    toggleFavorite,
    toggleHideEmptyFeeds,
    unreadCount,
    unsubscribe,
  } = r
  // A setting in its affirmative state (enabled, hidden) carries the accent
  // fill. This follows the row's own value, not the underlying boolean: blue on
  // "Auto-read: disabling" would read as a contradiction.
  const TOGGLE_ON = 'bg-accent/15 hover:bg-accent/20 active:bg-accent/25'

  const navigate = useNavigate()
  const [, setSearchParams] = useSearchParams()
  // Debounced typing writes the URL; the URL is the search state.
  const search = createSearch(r, (term) =>
    setSearchParams({ search: term, cursor: undefined }, { replace: true }),
  )

  let triggerEl: HTMLButtonElement | undefined
  let panelEl: HTMLDialogElement | undefined
  const [open, setOpen] = createSignal(false)

  const feedId = () => r.filter().feedId
  // Edit/unsubscribe/sort/auto-read only mean something for one feed — Latest,
  // Starred and category views are aggregates.
  const isFeedView = () => feedId() != null && feedId() !== ''
  const searchActive = () => Boolean(r.filter().search)
  const searchScope = () => r.searchScope()
  const autoReadOff = () =>
    (r.panel.userPrefs.disabledAutoReadFeeds ?? []).includes(feedId() as FeedId)

  const title = createMemo(() => currentTitle())
  const unread = createMemo(() => unreadCount())
  const viewMode = createMemo(() => effectiveViewMode())

  const isDesktop = () => matchMedia('(min-width: 48rem)').matches

  // ---- Placement ----

  /** Size and place the panel from the trigger's current rect. */
  const place = (): void => {
    if (!triggerEl || !panelEl) return
    const { top, left, width, maxHeight } = computePopoverPlacement({
      rect: triggerEl.getBoundingClientRect(),
      viewportWidth: window.visualViewport?.width ?? window.innerWidth,
      viewportHeight: window.visualViewport?.height ?? window.innerHeight,
      isDesktop: isDesktop(),
    })
    panelEl.style.top = `${top}px`
    panelEl.style.left = `${left}px`
    panelEl.style.width = `${width}px`
    panelEl.style.maxHeight = `${maxHeight}px`
  }

  // A window resize moves the trigger, but so can a layout change with no resize
  // — typing in the search box adds the 🔍 chip to the trigger. The observer
  // covers both, so the panel can't end up stranded behind the toolbar.
  let triggerObserver: ResizeObserver | null = null

  const watchTrigger = (): void => {
    window.addEventListener('resize', place)
    if (typeof ResizeObserver !== 'undefined' && triggerEl) {
      triggerObserver = new ResizeObserver(place)
      triggerObserver.observe(triggerEl)
    }
  }

  const unwatchTrigger = (): void => {
    window.removeEventListener('resize', place)
    triggerObserver?.disconnect()
    triggerObserver = null
  }

  // Browser-only: onCleanup would also run when the server disposes its render
  // owner, where there is no window to unwatch.
  onSettled(() => unwatchTrigger)

  const openPanel = (): void => {
    if (!panelEl || panelEl.open) return
    place()
    panelEl.showModal()
    setOpen(true)
    watchTrigger()
  }

  /** Also fires for Escape, so this is the single teardown point. */
  const onClose = (): void => {
    setOpen(false)
    unwatchTrigger()
  }

  /**
   * A click whose target is the dialog itself landed on the backdrop — the
   * classic tap-outside-to-dismiss. Nothing behind the backdrop is reachable
   * anyway: a modal makes the rest of the document inert, so only the backdrop
   * takes a tap.
   */
  const onPanelClick = (event: MouseEvent): void => {
    if (event.target === panelEl) closePanel()
  }

  const closePanel = (): void => {
    if (panelEl?.open) panelEl.close()
  }

  /** Every row dismisses the panel, so the action runner owns that. */
  const runAndClose = async (work: () => Promise<unknown> | unknown): Promise<void> => {
    try {
      await work()
    } finally {
      closePanel()
    }
  }

  // ---- Actions ----

  const onMarkAllRead = (): void => {
    markDisplayed()
    closePanel()
  }

  const onViewMode = () =>
    runAndClose(() => setViewMode(effectiveViewMode() === 'expanded' ? 'list' : 'expanded'))
  const onSort = () => runAndClose(() => setSort(r.sortOrder() === 'newest' ? 'oldest' : 'newest'))
  const onToggleAutoRead = () => runAndClose(() => toggleAutoRead(feedId() as FeedId))
  const onHideEmptyFeeds = () => runAndClose(() => toggleHideEmptyFeeds())
  const onHideReadItems = () => runAndClose(() => setHideReadItems(!r.hidesReadItems()))
  const onClearSearch = () => runAndClose(() => search.clearSearch())
  /** Keep the term, drop the view: the same results, no longer confined. */
  const onSearchAll = () =>
    runAndClose(() =>
      setSearchParams(
        { feed: undefined, category: undefined, starred: undefined },
        { replace: true },
      ),
    )

  const onEditFeed = (): void => {
    const id = feedId()
    if (id == null || id === '') return
    openEditFeed(id as FeedId)
    closePanel()
  }

  const onToggleFavorite = (): Promise<void> =>
    runAndClose(() => toggleFavorite(feedId() as FeedId))

  const onUnsubscribe = async (): Promise<void> => {
    const id = feedId()
    if (id == null || id === '') return
    if (!confirm('Unsubscribe from this feed?')) return
    await unsubscribe(id as FeedId)
    closePanel()
    await navigate('/')
  }

  const onLogout = async (): Promise<void> => {
    await api.logout()
    clearScrollMemory()
    closePanel()
    await navigate('/login')
  }

  return (
    <div class="min-w-0 flex-1 md:flex-none md:mr-auto">
      <button
        ref={(element) => {
          triggerEl = element
        }}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open() ? 'true' : 'false'}
        aria-controls={PANEL_ID}
        data-testid="feed-menu-trigger"
        class="w-full md:w-auto min-h-11 min-w-0 flex items-center gap-x-2 px-3 py-2 border border-line rounded-lg bg-white hover:bg-surface active:bg-line leading-none text-left"
        onClick={openPanel}
      >
        <span class="min-w-0 flex-1 truncate font-medium">{title()}</span>
        <Show when={unread() != null}>
          <span
            data-testid="feed-menu-count"
            class="shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent"
          >
            {unread()}
          </span>
        </Show>
        <Show when={searchActive()}>
          <span class="shrink-0 max-w-24 truncate text-xs text-muted" title={r.filter().search}>
            &#128269; {r.filter().search}
          </span>
        </Show>
        <span class="shrink-0 text-xs text-muted" aria-hidden="true">
          &#9662;
        </span>
      </button>

      <dialog
        id={PANEL_ID}
        ref={(element) => {
          panelEl = element
        }}
        aria-label="Feed actions and settings"
        class="inset-auto m-0 max-w-none max-h-none bg-white border border-line rounded-xl shadow-xl text-sm overflow-y-auto overscroll-contain backdrop:bg-black/40"
        onClick={onPanelClick}
        onClose={onClose}
      >
        <div class="flex flex-col">
          {/* Search: the only one on mobile, since the toolbar box is desktop
                  only. "Clear search" lives with it and is equally hidden on
                  desktop, where the toolbar box itself is the way to clear. */}
          <div class="md:hidden p-2 flex flex-col gap-1 border-b border-line">
            <input
              type="search"
              placeholder={searchScope() ? `Search in ${searchScope()}…` : 'Search all feeds…'}
              class="w-full min-h-11 px-3 py-2 border border-line rounded-lg"
              value={search.text()}
              onInput={(event) => search.onSearchInput(event.currentTarget.value)}
            />
            <Show when={searchActive()}>
              <button type="button" class="menu-row" onClick={onClearSearch}>
                Clear search
              </button>
            </Show>
          </div>

          {/* The scope is a deliberate state, so there is a way out of it that
              keeps the term. Shown at both widths; the desktop box has no room
              for a second control beside it. */}
          <Show when={searchActive() && searchScope()}>
            <div class="p-2 border-b border-line">
              <button
                type="button"
                class="menu-row"
                data-testid="search-all-feeds"
                onClick={() => void onSearchAll()}
              >
                Search all feeds
              </button>
            </div>
          </Show>

          {/* The one primary action on this surface. */}
          <div class="p-2 border-b border-line">
            <button
              type="button"
              class="w-full min-h-12 flex items-center justify-center gap-x-2 rounded-lg bg-accent text-white font-semibold cursor-pointer hover:brightness-95 active:brightness-90 disabled:opacity-60"
              onClick={onMarkAllRead}
            >
              <span aria-hidden="true">&#10003;</span>
              <span>Mark all read</span>
            </button>
          </div>

          {/* Every setting in one group, each reading as name: value, laid out
                  in the same two-up grid as the commands below. Sort and
                  read-items are omitted while a search is active: search is
                  always newest-first across both read buckets, so those rows
                  would contradict the list. */}
          <div class="p-2 grid grid-cols-2 gap-1 border-b border-line">
            <button type="button" class="menu-row" onClick={onViewMode}>
              View: {viewMode()}
            </button>
            <Show when={isFeedView() && !searchActive()}>
              <button type="button" class="menu-row" onClick={onSort}>
                Sort: {r.sortOrder() === 'oldest' ? 'oldest first' : 'newest first'}
              </button>
            </Show>
            <Show when={isFeedView()}>
              <button
                type="button"
                class={['menu-row', { [TOGGLE_ON]: !autoReadOff() }]}
                aria-pressed={autoReadOff() ? 'true' : 'false'}
                onClick={onToggleAutoRead}
              >
                Auto-read: {autoReadOff() ? 'disabled' : 'enabled'}
              </button>
            </Show>
            <button
              type="button"
              class={[
                'menu-row',
                {
                  [TOGGLE_ON]: r.panel.userPrefs.hideEmptyFeeds ?? DEFAULT_HIDE_EMPTY_FEEDS,
                },
              ]}
              aria-pressed={
                (r.panel.userPrefs.hideEmptyFeeds ?? DEFAULT_HIDE_EMPTY_FEEDS) ? 'true' : 'false'
              }
              onClick={onHideEmptyFeeds}
            >
              Empty feeds:{' '}
              {(r.panel.userPrefs.hideEmptyFeeds ?? DEFAULT_HIDE_EMPTY_FEEDS) ? 'hidden' : 'shown'}
            </button>
            <Show when={!searchActive()}>
              <button
                type="button"
                class={['menu-row', { [TOGGLE_ON]: r.hidesReadItems() }]}
                aria-pressed={r.hidesReadItems() ? 'true' : 'false'}
                onClick={onHideReadItems}
              >
                Read items: {r.hidesReadItems() ? 'hidden' : 'shown'}
              </button>
            </Show>
          </div>

          {/* Commands, in a two-up grid. Sign out spans the last row on its
                  own, so no cell is ever left half-empty. */}
          <div class="p-2 grid grid-cols-2 gap-1">
            <Show when={isFeedView()}>
              <button
                type="button"
                class="menu-row"
                data-testid="feed-menu-favorite"
                onClick={() => void onToggleFavorite()}
              >
                {isFavorite(feedId() as FeedId) ? 'Unfavorite feed' : 'Favorite feed'}
              </button>
              <button type="button" class="menu-row" onClick={onEditFeed}>
                Edit feed…
              </button>
              <button
                type="button"
                class="menu-row text-red-600"
                onClick={() => void onUnsubscribe()}
              >
                Unsubscribe
              </button>
            </Show>
            <button type="button" class="menu-row col-span-2" onClick={() => void onLogout()}>
              Sign out
            </button>
          </div>
        </div>
      </dialog>
    </div>
  )
}

export default FeedMenu
