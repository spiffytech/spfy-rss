import { describe, expect, test } from 'bun:test'

import { epochMs, idTimestamp, newEntryId, newFeedId, newUserId } from '../src/shared/ids'

describe('UUIDv7 ids', () => {
  test('are dashed hex UUIDv7 strings', () => {
    const id = newEntryId(epochMs(1_750_000_000_000))
    expect(id).toHaveLength(36)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  test('embed the seeded created_at in the first 48 bits', () => {
    for (const at of [0, 1, 1_750_000_000_000, 2 ** 47]) {
      expect(idTimestamp(newUserId(epochMs(at)))).toBe(epochMs(at))
    }
  })

  test('same-ms ids share the time prefix but get distinct random tails', () => {
    const at = epochMs(1_750_000_000_000)
    const a = newFeedId(at)
    const b = newFeedId(at)
    const strip = (s: string) => s.replaceAll('-', '')
    expect(strip(a).slice(0, 12)).toBe(strip(b).slice(0, 12))
    expect(a).not.toBe(b)
  })

  test('sort lexicographically in creation order across milliseconds', () => {
    const a = newEntryId(epochMs(1_750_000_000_000))
    const b = newEntryId(epochMs(1_750_000_000_001))
    expect(a < b).toBe(true)
  })
})
