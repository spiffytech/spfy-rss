/**
 * Debounced entry search, shared by the toolbar's desktop box and the mobile
 * feed popover's box. Both boxes sync from the active filter, so the two can
 * never disagree about what is being searched.
 */
import { createEffect, createSignal, untrack } from 'solid-js'

import type { Reader } from './reader'

const DEBOUNCE_MS = 300

export const createSearch = (r: Reader, onSearch: (term: string | undefined) => void) => {
  // Initial value only — the effect below keeps it in step with the filter.
  const [text, setText] = createSignal(untrack(() => r.filter().search ?? ''))
  let timer: ReturnType<typeof setTimeout> | undefined

  // Navigating to another view clears the filter's search — the box clears with it.
  createEffect(
    () => r.filter().search,
    (search) => {
      clearTimeout(timer)
      setText(search ?? '')
    },
  )

  /** Push the current text into the filter once typing pauses. */
  const onSearchInput = (value: string): void => {
    setText(value)
    clearTimeout(timer)
    timer = setTimeout(() => {
      // The URL is the search state; the projection re-runs off it.
      onSearch(value || undefined)
    }, DEBOUNCE_MS)
  }

  /** Drop the search immediately (the popover's "Clear search" row). */
  const clearSearch = (): void => {
    clearTimeout(timer)
    setText('')
    onSearch(undefined)
  }

  return { text, onSearchInput, clearSearch }
}
