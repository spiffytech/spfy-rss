/**
 * The reading pane's scroll position, across a page restore.
 *
 * The pane is an inner scroller (`body` never scrolls), and browsers only
 * restore the *document's* scroll after a reload. Android's WebView has a
 * further bug: a page restored from bfcache comes back at `scrollTop` 0 even
 * though its DOM and JS state are intact. So the reader keeps its own copy,
 * saved when the page is hidden and re-applied when it comes back.
 *
 * The anchor is an entry id, not just a pixel offset: entries arrive at the
 * top while the tab is away, which would otherwise shift the list under a bare
 * offset.
 */
import type { EntryId } from '../shared/ids'
import { scrollRoot } from './nav'

const KEY = 'mf-scroll'

type Saved = {
  /** The view the position belongs to; a different one is never inherited. */
  viewKey: string
  /** Rows the window held, so a position past the first page can be reached. */
  wanted: number
  top: number
  anchorId: EntryId | null
  /** The anchor's top edge relative to the scroll container's top edge. */
  anchorOffset: number
}

type Options = {
  viewKey: () => string
  /** Rows currently loaded. */
  wanted: () => number
  /** Grow the window to at least `count` rows. */
  ensureWindow: (count: number) => void
}

/** The first card still visible at the top of the pane, and where its top sits. */
const anchorOf = (container: HTMLElement): Pick<Saved, 'anchorId' | 'anchorOffset'> => {
  const containerTop = container.getBoundingClientRect().top
  for (const element of container.querySelectorAll<HTMLElement>('[data-entry-id]')) {
    const rect = element.getBoundingClientRect()
    if (rect.bottom > containerTop) {
      return {
        anchorId: (element.dataset['entryId'] as EntryId | undefined) ?? null,
        anchorOffset: rect.top - containerTop,
      }
    }
  }
  return { anchorId: null, anchorOffset: 0 }
}

const save = (options: Options): void => {
  const container = scrollRoot()
  if (!container) return
  try {
    const saved: Saved = {
      viewKey: options.viewKey(),
      wanted: options.wanted(),
      top: container.scrollTop,
      ...anchorOf(container),
    }
    sessionStorage.setItem(KEY, JSON.stringify(saved))
  } catch {
    // A full quota or a private window just means no remembered position.
  }
}

const load = (viewKey: string): Saved | null => {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return null
    const saved = JSON.parse(raw) as Saved
    return saved.viewKey === viewKey ? saved : null
  } catch {
    return null
  }
}

/**
 * Put the pane back. Returns false only when the anchor is not in the window
 * yet (the caller retries as appended rows arrive); the pixel offset is the
 * fallback when the list no longer has that entry at all.
 */
const apply = (saved: Saved, container: HTMLElement, options: Options): boolean => {
  options.ensureWindow(saved.wanted)
  if (saved.anchorId) {
    const anchor = document.getElementById(`entry-${saved.anchorId}`)
    if (anchor) {
      const offset = anchor.getBoundingClientRect().top - container.getBoundingClientRect().top
      container.scrollTop = Math.max(0, container.scrollTop + offset - saved.anchorOffset)
      return true
    }
  }
  container.scrollTop = saved.top
  return saved.anchorId === null
}

/** Save on hide, restore on return. Returns the cleanup. */
export const installScrollMemory = (options: Options): (() => void) => {
  let attempts = 0
  let stopped = false

  const restore = (): void => {
    if (stopped) return
    const container = scrollRoot()
    const saved = load(options.viewKey())
    if (!container || !saved) return
    // Nothing to do when the engine kept the position itself.
    if (container.scrollTop === saved.top) return
    if (apply(saved, container, options)) return
    // The rows the anchor needs are still being fetched (the saved position was
    // past the first page). Try for about a second, then leave the fallback.
    if (++attempts > 60) return
    requestAnimationFrame(restore)
  }

  const onHide = (): void => save(options)
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') restore()
  }
  const onPageShow = (event: PageTransitionEvent): void => {
    if (!event.persisted) return
    attempts = 0
    restore()
  }

  addEventListener('pagehide', onHide)
  addEventListener('pageshow', onPageShow)
  document.addEventListener('visibilitychange', onVisible)

  // A reload is a fresh mount: this is where a saved position is picked up.
  restore()

  return () => {
    stopped = true
    removeEventListener('pagehide', onHide)
    removeEventListener('pageshow', onPageShow)
    document.removeEventListener('visibilitychange', onVisible)
  }
}
