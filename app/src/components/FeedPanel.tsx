import { For, Show, createMemo } from 'solid-js'
import { useNavigate } from '@solidjs/router'

import type { FeedInfo } from '../shared/types'
import { DEFAULT_HIDE_EMPTY_FEEDS } from '../shared/prefs'
import { hasView } from '../shared/filter'
import { compareTitlesCI, timeAgo } from '../shared/util'
import { autofocus } from '../lib/observers'
import { useReader } from '../lib/reader-context'
import { FeedIcon } from './FeedIcon'
import { OpmlControls } from './OpmlControls'

/**
 * The sidebar: Sections (Latest/Starred) + Feeds. Uncategorized feeds sit at the
 * top level, then flat folders with inline rename editors and the hover-pencil.
 *
 * Navigation is URL-first: picking a feed is a link, so the reading view's
 * identity stays in the address bar. Re-clicking the active feed is the one
 * exception — it refetches page 1 in place, because new items may have arrived
 * since the list windowed.
 */
export const FeedPanel = () => {
  const r = useReader()
  const { cancelRename, openAddFeed, openEditFeed, refreshPanel, saveRename, startRename } = r
  const navigate = useNavigate()

  // Case-insensitive order inside each folder (the server hands them over in
  // SQLite's binary collation order, which puts every capital letter first).
  /** A folder's total is the sum of the feed counts under it, not a separate number. */
  const categoryUnread = (categoryId: string): number =>
    (feedsByCategory().get(categoryId) ?? []).reduce((total, feed) => total + r.counterFor(feed.id), 0)

  const sortedFeeds = createMemo(() =>
    [...r.panel.feeds].sort((a, b) => compareTitlesCI(a.title, b.title)),
  )

  const uncategorizedFeeds = createMemo(() => sortedFeeds().filter((feed) => feed.categoryId === null))

  const feedsByCategory = createMemo(() => {
    const map = new Map<string, FeedInfo[]>()
    for (const feed of sortedFeeds()) {
      if (feed.categoryId === null) continue
      const list = map.get(feed.categoryId) ?? []
      list.push(feed)
      map.set(feed.categoryId, list)
    }
    return map
  })

  const sortedCategories = createMemo(() =>
    [...r.panel.categories].sort((a, b) => compareTitlesCI(a.title, b.title)),
  )

  /** Identity-only nav URL (which feed/category/section). */
  const link = (params: Record<string, string | number | null | undefined>): string => {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value != null && value !== '') query.set(key, String(value))
    }
    const queryString = query.toString()
    return queryString ? `/?${queryString}` : '/'
  }

  const isActiveFeed = (feedId: string) => r.filter().feedId === feedId

  /**
   * The fetch warning's tooltip: how many failures in the streak, when the feed
   * was last tried, and the message the failure carried. Only what the server
   * stored — the streak resets (and the message clears) on the next good fetch.
   */
  const fetchWarning = (feed: FeedInfo): string | null => {
    if (feed.parsingErrorCount === 0) return null
    const parts = [
      `${feed.parsingErrorCount} fetch ${feed.parsingErrorCount === 1 ? 'error' : 'errors'}`,
    ]
    if (feed.lastErrorAt !== null) parts.push(`last tried ${timeAgo(feed.lastErrorAt)}`)
    if (feed.lastError) parts.push(feed.lastError)
    return parts.join(' · ')
  }

  const isRenamingCategory = (categoryId: string) =>
    r.session.renameId === categoryId && r.session.renameKind === 'category'
  const hideEmptyFeeds = () => r.panel.userPrefs.hideEmptyFeeds ?? DEFAULT_HIDE_EMPTY_FEEDS

  const showCategory = (catFeeds: FeedInfo[]): boolean => {
    if (!hideEmptyFeeds()) return true
    const hasUnread = catFeeds.some((feed) => r.counterFor(feed.id) > 0)
    const hasActive = catFeeds.some((feed) => r.filter().feedId === feed.id)
    return hasUnread || hasActive
  }

  const onRenameKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Enter') void saveRename()
    else if (event.key === 'Escape') cancelRename()
  }

  const RenameEditor = (props: { onCancel: () => void; onSave: () => void }) => (
    <span class="flex flex-col flex-1 min-w-0 gap-1">
      <input
        type="text"
        ref={autofocus}
        class="w-full p-0.5 border border-gray-300 rounded text-sm"
        value={r.session.renameTitle}
        onInput={(event) => r.setRenameTitle(event.currentTarget.value)}
        onKeyDown={onRenameKeydown}
      />
      <div class="flex items-center justify-end gap-1">
        <button
          type="button"
          class="text-xs shrink-0 px-2 py-0.5 rounded-md bg-cyan-700 text-white hover:bg-cyan-800"
          onClick={props.onSave}
        >
          Save
        </button>
        <button
          type="button"
          class="text-xs shrink-0 px-2 py-0.5 rounded-md border border-gray-300 hover:bg-gray-100"
          onClick={props.onCancel}
        >
          Cancel
        </button>
      </div>
    </span>
  )

  /** One feed row, shared by the uncategorized group and the folder lists. */
  const FeedRow = (props: { feed: FeedInfo }) => (
    <li
      class={[
        // Baseline-aligned so the feed name and its count sit on one line of
        // text; the icon opts back into centring for itself.
        'group flex items-baseline gap-x-2 text-sm',
        {
          hidden:
            hideEmptyFeeds() &&
            r.counterFor(props.feed.id) === 0 &&
            !isActiveFeed(props.feed.id),
        },
      ]}
    >
      <FeedIcon feedId={props.feed.id} title={props.feed.title} />
      <a
        href={link({ feed: props.feed.id })}
        class={[
          'flex-1 min-w-0 flex items-baseline gap-x-2 py-2 rounded hover:bg-gray-100',
          { 'bg-gray-100': isActiveFeed(props.feed.id) },
        ]}
        onClick={(event) => {
          event.preventDefault()
          if (isActiveFeed(props.feed.id)) refreshPanel()
          else void navigate(link({ feed: props.feed.id }))
        }}
      >
        <span class="flex-1 truncate">{props.feed.title}</span>
      </a>
      {/* Right-hand cluster, left to right: fetch errors, favorite, unread
          count (which the pencil replaces on hover). */}
      <span class="relative flex items-baseline gap-x-1 shrink-0">
        <Show when={props.feed.parsingErrorCount > 0}>
          <span
            data-testid="feed-error"
            role="img"
            tabindex="0"
            aria-label={fetchWarning(props.feed) ?? 'Fetch errors'}
            title={fetchWarning(props.feed) ?? 'Fetch errors'}
          >
            ⚠️
          </span>
        </Show>
        <Show when={r.isFavorite(props.feed.id)}>
          <span
            data-testid="feed-favorite"
            title="On the home page"
            class="shrink-0 text-xs text-amber-500"
          >
            ★
          </span>
        </Show>
        <span
          data-testid="feed-count"
          class="text-xs text-gray-500 transition-opacity duration-150 group-hover:delay-250 group-hover:opacity-0"
        >
          {r.counterFor(props.feed.id)}
        </span>
        <button
          type="button"
          title="Edit feed"
          aria-label={`Edit ${props.feed.title}`}
          class="absolute inset-y-0 right-0 text-xs text-gray-500 opacity-0 transition-opacity duration-150 group-hover:delay-250 group-hover:opacity-100 hover:text-gray-900 px-0.5 cursor-pointer"
          onClick={() => openEditFeed(props.feed.id)}
        >
          ✎
        </button>
      </span>
    </li>
  )

  return (
    <aside
      data-testid="feed-panel"
      class="border-r border-gray-200 pr-2 overflow-y-auto min-h-0"
    >
      <div class="mb-1">
        <h2 class="font-semibold text-sm mb-1">Sections</h2>
        <ul class="text-sm">
          <li>
            {/* No filter means the home page. It is first because it is the way
                back out of any feed — the toolbar title does this on desktop, but
                on mobile the title is hidden and this list is the only nav. */}
            <a
              href="/"
              data-testid="home-link"
              class={[
                'w-full text-left px-2 py-1 rounded hover:bg-gray-100 flex justify-between items-center',
                { 'bg-gray-100': !hasView(r.filter()) },
              ]}
            >
              <span>Home</span>
            </a>
          </li>
          <li>
            <a
              href={link({ starred: 1 })}
              class={[
                'w-full text-left px-2 py-1 rounded hover:bg-gray-100 flex justify-between items-center',
                { 'bg-gray-100': r.filter().starred === true },
              ]}
            >
              <span>Starred</span>
            </a>
          </li>
        </ul>
      </div>

      <div>
        <div class="flex items-center justify-between gap-2 mb-1">
          <h2 class="font-semibold text-sm">Feeds</h2>
          <button
            type="button"
            title="Add feed"
            aria-label="Add feed"
            data-testid="add-feed"
            class="min-h-11 min-w-11 inline-flex items-center justify-center text-lg leading-none rounded text-gray-600 hover:bg-gray-100 hover:text-gray-900 cursor-pointer"
            onClick={openAddFeed}
          >
            +
          </button>
        </div>

        <ul>
          <Show when={uncategorizedFeeds().length > 0 && showCategory(uncategorizedFeeds())}>
            <li>
              <h2 class="text-sm font-semibold truncate py-2">Uncategorized</h2>
              <ul class="ml-3">
                <For each={uncategorizedFeeds()}>{(feed) => <FeedRow feed={feed} />}</For>
              </ul>
            </li>
          </Show>

          <For each={sortedCategories()}>
            {(category) => (
              <Show when={showCategory(feedsByCategory().get(category.id) ?? [])}>
                <li>
                  <div class="group flex items-baseline gap-x-2 text-sm font-semibold">
                    <Show
                      when={isRenamingCategory(category.id)}
                      fallback={
                        <h2 class="flex-1 min-w-0 text-sm font-semibold truncate py-2">
                          {category.title}
                        </h2>
                      }
                    >
                      <RenameEditor
                        onCancel={cancelRename}
                        onSave={() => void saveRename()}
                      />
                    </Show>
                    <span class="relative flex items-baseline gap-x-1 shrink-0">
                      <span
                        data-testid="feed-count"
                        class="text-xs text-gray-500 transition-opacity duration-150 group-hover:delay-250 group-hover:opacity-0"
                      >
                        {categoryUnread(category.id)}
                      </span>
                      <button
                        type="button"
                        title="Rename folder"
                        class="absolute inset-y-0 right-0 text-xs text-gray-500 opacity-0 transition-opacity duration-150 group-hover:delay-250 group-hover:opacity-100 hover:text-gray-900 px-0.5 cursor-pointer"
                        onClick={() => startRename(category.id, category.title)}
                      >
                        ✎
                      </button>
                    </span>
                  </div>
                  <ul class="ml-3">
                    <For each={feedsByCategory().get(category.id) ?? []}>
                      {(feed) => <FeedRow feed={feed} />}
                    </For>
                  </ul>
                </li>
              </Show>
            )}
          </For>
        </ul>
      </div>

      <OpmlControls />
    </aside>
  )
}

export default FeedPanel
