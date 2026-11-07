/**
 * Ported from the old app's src/shared/util.test.ts. The `lazyHtml` block is
 * not here: that behaviour is now `applyEmbedHints` (a post-sanitize DOM pass,
 * since string-level attribute injection would be stripped by the sanitizer),
 * and it is asserted in the browser suite where a real DOM exists.
 *
 * Three adaptations, each forced by the new data model and behaviour-preserving:
 *   - ids are UUIDv7 strings, not Miniflux integers
 *   - feeds carry a flat `categoryId` rather than a nested `category`
 *   - `timeAgo` takes epoch-ms (the app's timestamp unit), not an ISO string
 */
import { describe, expect, test } from 'bun:test'

import { computeUnreadCount, compareTitlesCI, timeAgo } from '../src/shared/util'

describe('computeUnreadCount', () => {
  const feeds = [
    { id: 'f1', categoryId: 'c10' },
    { id: 'f2', categoryId: 'c10' },
    { id: 'f3', categoryId: 'c11' },
  ]
  const unreads: Record<string, number> = { f1: 5, f2: 0, f3: 7 }

  test('feed unread count', () => {
    expect(computeUnreadCount({ feedId: 'f1' }, feeds, unreads)).toBe(5)
  })

  test('missing feed count is 0', () => {
    expect(computeUnreadCount({ feedId: 'missing' }, feeds, unreads)).toBe(0)
  })

  test('starred has no meaningful count', () => {
    expect(computeUnreadCount({ starred: true }, feeds, unreads)).toBeNull()
  })

  test('category sums its feeds', () => {
    expect(computeUnreadCount({ categoryId: 'c10' }, feeds, unreads)).toBe(5)
  })

  test('Latest sums everything', () => {
    expect(computeUnreadCount({}, feeds, unreads)).toBe(12)
  })
})

describe('timeAgo', () => {
  test('under a minute', () => {
    expect(timeAgo(Date.now() - 30_000)).toBe('now')
  })

  test('minutes', () => {
    expect(timeAgo(Date.now() - 5 * 60_000)).toBe('5m')
  })

  test('hours', () => {
    expect(timeAgo(Date.now() - 3 * 3_600_000)).toBe('3h')
  })

  test('days', () => {
    expect(timeAgo(Date.now() - 12 * 86_400_000)).toBe('12d')
  })

  test('months and years', () => {
    expect(timeAgo(Date.now() - 90 * 86_400_000)).toBe('3mo')
    expect(timeAgo(Date.now() - 800 * 86_400_000)).toBe('2y')
  })

  test('invalid input renders empty', () => {
    expect(timeAgo(Number.NaN)).toBe('')
  })
})

describe('compareTitlesCI (sidebar order)', () => {
  test('ignores case, so capitals do not jump the queue', () => {
    const titles = ['Zebra feed', 'apple feed', 'Blog', 'cherry feed']
    expect([...titles].sort(compareTitlesCI)).toEqual([
      'apple feed',
      'Blog',
      'cherry feed',
      'Zebra feed',
    ])
  })

  test('sorts alphabetically, not by code point', () => {
    // Binary collation would give ['Cherry', 'Zebra', 'apple'] here.
    expect(['apple', 'Zebra', 'Cherry'].sort(compareTitlesCI)).toEqual(['apple', 'Cherry', 'Zebra'])
  })

  test('accents compare equal to their base letter (sensitivity: base)', () => {
    expect(compareTitlesCI('emile', 'Émile')).toBe(0)
    expect(compareTitlesCI('Zebra', 'éclair')).toBeGreaterThan(0)
  })
})
