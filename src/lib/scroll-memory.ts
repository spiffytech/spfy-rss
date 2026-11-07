/**
 * The reading pane's scroll position, across a page restore.
 *
 * The pane is an inner scroller (`body` never scrolls), and browsers only
 * restore the *document's* scroll after a reload. Android's WebView has a
 * further bug: a page restored from bfcache comes back at `scrollTop` 0 even
 * though its DOM and JS state are intact. So the reader keeps its own copy,
 * saved when the page is hidden and re-applied when it comes back.
 *
 * The position is an entry id plus its top offset, not a row count or a bare
 * pixel scroll. Entries arrive at the top while the tab is away, which would
 * otherwise shift the list under a bare offset; the id follows the content.
 * The offset is the first visible card's top relative to the pane's top (small,
 * usually negative), so restoring puts that same card back where it was.
 */
import type { EntryId } from '../shared/ids'
import { scrollRoot } from './nav'

/** A new key: an older payload shape must not be half-read after a deploy. */
const KEY = 'mf-scroll:2'
const OLD_KEY = 'mf-scroll'
const SAVE_DEBOUNCE_MS = 250
const RESTORE_DEADLINE_MS = 8_000

type Saved = {
  /** The view the position belongs to; a different one is never inherited. */
  view: string
  /** The first entry visible at the top of the pane. */
  anchor: EntryId
  /** The anchor's top edge relative to the pane's top edge, in whole pixels. */
  offset: number
}

type Options = {
  viewKey: () => string
  /** Ensure an entry is in the window (fetching pages if needed). */
  ensureEntry: (entryId: EntryId) => boolean
}

/** The first card still visible at the top of the pane, and where its top sits. */
const anchorOf = (container: HTMLElement): Omit<Saved, 'view'> | null => {
  const containerTop = container.getBoundingClientRect().top
  for (const element of container.querySelectorAll<HTMLElement>('[data-entry-id]')) {
    const rect = element.getBoundingClientRect()
    if (rect.bottom > containerTop) {
      const anchor = element.dataset['entryId'] as EntryId | undefined
      if (!anchor) return null
      return { anchor, offset: Math.round(rect.top - containerTop) }
    }
  }
  // Nothing visible (an empty view): there is no position worth keeping.
  return null
}

const save = (options: Options): void => {
  const container = scrollRoot()
  if (!container) return
  const anchor = anchorOf(container)
  if (!anchor) return
  try {
    const saved: Saved = { view: options.viewKey(), ...anchor }
    sessionStorage.setItem(KEY, JSON.stringify(saved))
  } catch {
    // A full quota or a private window just means no remembered position.
  }
}

const load = (view: string): Saved | null => {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return null
    const saved = JSON.parse(raw) as Partial<Saved>
    if (
      saved.view !== view ||
      typeof saved.anchor !== 'string' ||
      typeof saved.offset !== 'number' ||
      !Number.isFinite(saved.offset)
    )
      return null
    return saved as Saved
  } catch {
    return null
  }
}

/** Put the pane back on the saved anchor. False means "not in the DOM yet". */
const apply = (saved: Saved, container: HTMLElement): boolean => {
  const anchor = document.getElementById(`entry-${saved.anchor}`)
  if (!anchor) return false
  const offset = anchor.getBoundingClientRect().top - container.getBoundingClientRect().top
  container.scrollTop = Math.max(0, container.scrollTop + offset - saved.offset)
  return true
}

/** Forget the position for this tab (logout changes who the data belongs to). */
export const clearScrollMemory = (): void => {
  try {
    sessionStorage.removeItem(KEY)
    sessionStorage.removeItem(OLD_KEY)
  } catch {
    // ignore: no storage means nothing to clear
  }
}

/** Save as you scroll, restore when the page comes back. Returns the cleanup. */
export const installScrollMemory = (options: Options): (() => void) => {
  let stopped = false
  let deadline = 0
  let saveTimer: ReturnType<typeof setTimeout> | undefined

  const retry = (): void => {
    if (stopped) return
    if (performance.now() > deadline) return
    requestAnimationFrame(restore)
  }

  const restore = (): void => {
    if (stopped) return
    const saved = load(options.viewKey())
    if (!saved) return
    const container = scrollRoot()
    // The first restore can run before the list has mounted; keep trying rather
    // than giving up on a page load whose data is still landing.
    if (!container) {
      retry()
      return
    }
    if (apply(saved, container)) return
    // The anchor is beyond the first window (new entries arrived above it).
    // Grow the window a page at a time until it appears or the list ends.
    options.ensureEntry(saved.anchor)
    retry()
  }

  const startRestore = (): void => {
    deadline = performance.now() + RESTORE_DEADLINE_MS
    restore()
  }

  const onHide = (): void => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = undefined
    }
    save(options)
  }
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') startRestore()
  }
  const onPageShow = (event: PageTransitionEvent): void => {
    if (!event.persisted) return
    startRestore()
  }
  const onFreeze = (): void => onHide()
  const onResume = (): void => startRestore()
  const onScroll = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(onHide, SAVE_DEBOUNCE_MS)
  }

  addEventListener('pagehide', onHide)
  addEventListener('pageshow', onPageShow)
  document.addEventListener('visibilitychange', onVisible)
  // Page Lifecycle API (Android): the events that fire when a tab is frozen or
  // killed without a pagehide. The debounced scroll save is the final fallback.
  document.addEventListener('freeze', onFreeze)
  document.addEventListener('resume', onResume)
  document.addEventListener('scroll', onScroll, { capture: true, passive: true })

  // A reload is a fresh mount: this is where a saved position is picked up.
  startRestore()

  return () => {
    stopped = true
    if (saveTimer) clearTimeout(saveTimer)
    removeEventListener('pagehide', onHide)
    removeEventListener('pageshow', onPageShow)
    document.removeEventListener('visibilitychange', onVisible)
    document.removeEventListener('freeze', onFreeze)
    document.removeEventListener('resume', onResume)
    document.removeEventListener('scroll', onScroll, { capture: true })
  }
}
