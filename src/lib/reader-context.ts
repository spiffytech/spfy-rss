import { createContext, useContext } from 'solid-js'

import type { Reader } from './reader'

/**
 * The page's reader, provided by the reader page and consumed by everything
 * beneath it.
 *
 * A context rather than a module singleton for one reason: a server render must
 * never share mutable state with another request. The page creates the reader,
 * so its lifetime is the render's (server) or the page's (client) — stateless
 * requests, by construction.
 */
export const ReaderContext = createContext<Reader>()

export const useReader = (): Reader => {
  const reader = useContext(ReaderContext)
  if (!reader) throw new Error('useReader() must be called inside the reader page')
  return reader
}
