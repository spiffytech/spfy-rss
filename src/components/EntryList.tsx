import { For, Show, onSettled } from 'solid-js'

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
  // A fetch can be in flight when the sentinel reports again; the store guards
  // both paths with `loadingMore`.
  const onSentinel = (): void | Promise<void> => (pageHasMore() ? loadMore() : checkTail())

  return (
    <div data-testid="entry-list" class="flex flex-col gap-y-1 px-2 md:px-0 pb-[100dvh]">
      <Show when={r.entries().length === 0}>
        <p class="text-gray-500 text-sm px-2 py-4">No entries.</p>
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
