import { Show, createSignal } from 'solid-js'

import type { FeedId } from '../shared/ids'
import { useReader } from '../lib/reader-context'

/**
 * The feed's icon, with a letter fallback when there is none or it fails.
 *
 * The request is skipped entirely for a feed with no stored icon: asking anyway
 * turned into a 404 per row. A failed load is remembered by *this element*, not by
 * the session — a session-wide "this icon 404'd" flag has no invalidation, so an
 * icon the scheduler fetched later would keep showing a letter until reload.
 *
 * `/api/icons/:id` stays a plain URL endpoint rather than a server function: it
 * is an <img src>, and an <img> cannot speak the RPC protocol.
 */
export const FeedIcon = (props: { feedId: FeedId; title: string }) => {
  const r = useReader()
  const [failed, setFailed] = createSignal(false)
  const src = () => (failed() ? null : r.iconUrl(props.feedId))

  return (
    <span class="inline-flex items-center self-center shrink-0 relative w-5 h-5" aria-hidden="true">
      <Show when={src()} keyed>
        {(url) => (
          <img
            src={url}
            alt=""
            class="w-5 h-5 rounded-sm"
            loading="lazy"
            onError={() => setFailed(true)}
          />
        )}
      </Show>
      <Show when={!src()}>
        <span class="absolute inset-0 inline-flex items-center justify-center rounded-sm bg-gray-200 text-gray-600 text-xs font-semibold">
          {(props.title.trim()[0] ?? '?').toUpperCase()}
        </span>
      </Show>
    </span>
  )
}

export default FeedIcon
