import { describe, expect, test } from 'bun:test'

import { filterIdentity, hasView, parseFilterFromUrl, searchScopeLabel } from '../src/shared/filter'

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

/**
 * Searching inside the current feed is intended; what was missing is any way to
 * say so. The label is what the header and the empty state render, and the
 * identity has to change when the scope does or the list keeps its old rows.
 */
describe('search scope', () => {
  const feeds = [{ id: 'f1', title: 'Blog' }]
  const categories = [{ id: 'c1', title: 'Tech' }]

  test('names the feed, folder or section a search is confined to', () => {
    expect(
      searchScopeLabel(parseFilterFromUrl({ feed: 'f1', search: 'solid' }), feeds, categories),
    ).toBe('Blog')
    expect(
      searchScopeLabel(parseFilterFromUrl({ category: 'c1', search: 'solid' }), feeds, categories),
    ).toBe('Tech')
    expect(
      searchScopeLabel(parseFilterFromUrl({ starred: '1', search: 'solid' }), feeds, categories),
    ).toBe('Starred')
  })

  test('a search outside any view has no scope', () => {
    expect(searchScopeLabel(parseFilterFromUrl({ search: 'solid' }), feeds, categories)).toBeNull()
  })

  test('the same term in two scopes is two different views', () => {
    expect(filterIdentity(parseFilterFromUrl({ feed: 'f1', search: 'q' }))).not.toBe(
      filterIdentity(parseFilterFromUrl({ search: 'q' })),
    )
  })
})
