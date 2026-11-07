import { expect, test } from 'bun:test'

import { swipeDirection } from '../src/lib/swipe'

test('a swipe is horizontal, long enough, and not mostly vertical', () => {
  const cases: Array<[dx: number, dy: number, expected: -1 | 0 | 1]> = [
    [80, 0, 1],
    [-80, 0, -1],
    [64, 0, 1], // the threshold itself counts
    [63, 0, 0],
    [-63, 0, 0],
    [80, 40, 1], // 0.5 of dx: still a swipe
    [80, -40, 1],
    [80, 60, 0], // past 0.6 of dx: a diagonal drag, not a swipe
    [-80, 55, 0],
    [10, 100, 0], // scrolling
    [0, 200, 0],
  ]
  for (const [dx, dy, expected] of cases) {
    expect({ dx, dy, direction: swipeDirection(dx, dy) }).toEqual({ dx, dy, direction: expected })
  }
})

test('the minimum distance is a parameter', () => {
  expect(swipeDirection(30, 0)).toBe(0)
  expect(swipeDirection(30, 0, 20)).toBe(1)
})
