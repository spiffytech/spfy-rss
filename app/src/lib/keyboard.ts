/**
 * Global keyboard shortcuts.
 *
 * Movement: j/k/arrows move the reading anchor (and auto-read). Actions: m
 * toggles read, s stars, o/Enter opens the original, v toggles view mode,
 * Shift+A marks the displayed set read (explicit-ID semantics: exactly the IDs
 * the view fetched). Scrolling: Space/Shift+Space page, g/G jump to the top or
 * bottom. `/` focuses search on desktop, where the box is visible.
 *
 * Returns a cleanup function; call it from `onCleanup` inside `onMount`.
 */
import type { EntryId } from '../shared/ids'
import type { Reader } from './reader'

const DESKTOP_QUERY = '(min-width: 48rem)'

export const attachKeyboard = (
  r: Reader,
  onToggleViewMode: () => void,
): (() => void) => {
  const currentEntry = (): { id: EntryId } | null => {
    const id = r.currentEntryId()
    return id == null ? null : { id }
  }

  const scrollPane = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('[data-testid="entry-scroll"]')

  /** Open the anchored entry's original URL in a new tab. */
  const openCurrent = (): void => {
    const id = r.currentEntryId()
    if (id == null) return
    const url = r.entries().find((entry) => entry.id === id)?.url
    if (url) window.open(url, '_blank', 'noopener,noreferrer')
  }

  /** One screenful of the entry pane, less a little overlap for continuity. */
  const page = (direction: 1 | -1): void => {
    const pane = scrollPane()
    if (!pane) return
    pane.scrollBy({ top: direction * pane.clientHeight * 0.9 })
  }

  const onKeydown = (event: KeyboardEvent) => {
    // Don't hijack typing: bail when focus is inside a text/edit control.
    const target = event.target as HTMLElement | null
    if (target && target.closest('input, textarea, select, [contenteditable="true"]')) return

    if (event.key === 'j' || event.key === 'ArrowDown') {
      event.preventDefault()
      r.moveAndRead(1)
    } else if (event.key === 'k' || event.key === 'ArrowUp') {
      event.preventDefault()
      r.moveAndRead(-1)
    } else if (event.key === 'm') {
      const current = currentEntry()
      if (current) r.toggleRead(current.id)
    } else if (event.key === 's') {
      const current = currentEntry()
      if (current) void r.toggleStar(current.id)
    } else if (event.key === 'o' || event.key === 'Enter') {
      // Let a focused button or link do what Enter means there.
      if (event.key === 'Enter' && target?.closest('a, button, [role="button"]')) return
      event.preventDefault()
      openCurrent()
    } else if (event.key === 'v') {
      onToggleViewMode()
    } else if (event.key === 'A' && event.shiftKey) {
      event.preventDefault()
      r.markDisplayed()
    } else if (event.key === ' ') {
      event.preventDefault()
      page(event.shiftKey ? -1 : 1)
    } else if (event.key === 'g' || event.key === 'G') {
      const pane = scrollPane()
      if (!pane) return
      event.preventDefault()
      pane.scrollTop = event.key === 'g' ? 0 : pane.scrollHeight
    } else if (event.key === '/') {
      // Desktop only: the mobile search box lives in the feed menu, which this
      // shortcut deliberately does not open.
      if (!matchMedia(DESKTOP_QUERY).matches) return
      const search = document.querySelector<HTMLInputElement>('#reader-search')
      if (!search) return
      event.preventDefault()
      search.focus()
      search.select()
    }
  }

  window.addEventListener('keydown', onKeydown)
  return () => window.removeEventListener('keydown', onKeydown)
}
