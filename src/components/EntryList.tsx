import { For, Show, onSettled } from 'solid-js'
import { useSearchParams } from '@solidjs/router'

import { EntryItem } from './EntryItem'
import { observeSentinel } from '../lib/observers'
import { useReader } from '../lib/reader-context'

/**
 * The display window + end sentinel. The sentinel pages the keyset window; once
 * the window is exhausted it rechecks the tail for arrivals. The generous bottom
 * padding lets the last item scroll all the way to the top of the scroll
 * container (as the old EntryList did).
 */
export const EntryList = () => {
  const r = useReader()
  const { checkTail, loadMore } = r
  const pageHasMore = () => r.page.nextCursor !== null
  const [, setSearchParams] = useSearchParams()
  /** A search with no matches inside a feed/folder/section. */
  const scopedSearch = () => Boolean(r.filter().search) && r.searchScope() !== null
  const onSearchAll = () =>
    setSearchParams({ feed: undefined, category: undefined, starred: undefined }, { replace: true })
  // A fetch can be in flight when the sentinel reports again; the store guards
  // both paths with `loadingMore`.
  const onSentinel = (): void | Promise<void> => (pageHasMore() ? loadMore() : checkTail())

  return (
    <div data-testid="entry-list" class="flex flex-col gap-y-1 px-2 md:px-0 pb-[100dvh]">
      <Show when={r.entries().length === 0}>
        <div class="text-gray-500 text-sm px-2 py-4">
          <p>{scopedSearch() ? `No matches in ${r.searchScope()}.` : 'No entries.'}</p>
          {/* The dead end is where the scope becomes visible; offer the way out. */}
          <Show when={scopedSearch()}>
            <button
              type="button"
              data-testid="search-all-feeds-empty"
              class="mt-2 min-h-11 px-3 rounded-lg bg-gray-50 text-ink hover:bg-gray-100 active:bg-gray-200 cursor-pointer"
              onClick={onSearchAll}
            >
              Search all feeds
            </button>
          </Show>
        </div>
      </Show>
      <For each={r.entries()}>{(entry) => <EntryItem entry={entry} />}</For>
      <div
        id="entry-sentinel"
        class="h-1 w-full"
        ref={(element) => {
          // Observe after mount, not in the ref: a ref runs before the element is
          // in the document, so looking up the scroll root there finds nothing
          // and the sentinel never intersects.
          //
          // The cleanup belongs to the ref, not to `onSettled`: a ref callback has
          // no owner, and returning a cleanup from `onSettled` there throws
          // SETTLED_CLEANUP_UNOWNED — which halts the reactive system in dev.
          let stop: (() => void) | undefined
          let cancelled = false
          onSettled(() => {
            if (!cancelled) stop = observeSentinel(element, onSentinel)
          })
          return () => {
            cancelled = true
            stop?.()
          }
        }}
      />
    </div>
  )
}

export default EntryList
