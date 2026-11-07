import { describe, expect, test } from 'bun:test'

import { hasView, parseFilterFromUrl } from '../src/shared/filter'

/**
 * `hasView` is the divide between "the URL names a view" and "the home page".
 *
 * It is load-bearing twice: the reading surface renders entries only when it is
 * true, and the list's projection refuses to read a window when it is false. When
 * those two disagreed, the home page asked the server for entries with no filter,
 * the server refused, and the rejection halted the reactive system — after which
 * no navigation worked again.
 */
describe('hasView', () => {
  test('an empty filter is the home page', () => {
    expect(hasView(parseFilterFromUrl({}))).toBe(false)
  })

  test.each([
    ['a feed', { feed: '01a12b68-51d3-7338-9f24-a93830378cc9' }],
    ['a category', { category: '01a12b68-51d3-7338-9f24-a93830378cc9' }],
    ['the starred section', { starred: '1' }],
    ['a search', { search: 'solid' }],
  ])('%s names a view', (_label, query) => {
    expect(hasView(parseFilterFromUrl(query))).toBe(true)
  })

  test('view preferences alone do not name a view', () => {
    // Sort mode and hide-read live in prefs, but a URL that carries only those
    // still has no identity — it must not trigger an entries read.
    expect(hasView(parseFilterFromUrl({ sort: 'newest', hideRead: '0' }))).toBe(false)
  })
})
