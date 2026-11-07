/**
 * Branded IDs and the one time representation.
 *
 * Every row key is a UUIDv7 string (dashed hex, 36 chars) whose first 48 bits
 * embed the row's `created_at` in epoch milliseconds — seeded at first insert
 * via `Bun.randomUUIDv7('hex', createdAtMs)`. The random tail is assigned once;
 * upserts match on natural keys (entry hash, feed_url, username, category
 * title), so re-runs are idempotent and the tail never needs regeneration.
 *
 * Times are epoch-ms integers everywhere (`EpochMs`): they cross the JSON
 * boundary unchanged, so no `toSec`/ISO helpers ever come back.
 */

declare const brand: unique symbol
export type Brand<T, B extends string> = T & { readonly [brand]: B }

export type UserId = Brand<string, 'UserId'>
export type CategoryId = Brand<string, 'CategoryId'>
export type FeedId = Brand<string, 'FeedId'>
export type EntryId = Brand<string, 'EntryId'>
export type IconId = Brand<string, 'IconId'>

export type EpochMs = Brand<number, 'EpochMs'>

export type EntryStatus = 'unread' | 'read' | 'removed'

export function epochMs(ms: number): EpochMs {
  return ms as EpochMs
}

function uuidv7(at: EpochMs): string {
  return Bun.randomUUIDv7('hex', at as number)
}

export const newUserId = (at: EpochMs): UserId => uuidv7(at) as UserId
export const newCategoryId = (at: EpochMs): CategoryId => uuidv7(at) as CategoryId
export const newFeedId = (at: EpochMs): FeedId => uuidv7(at) as FeedId
export const newEntryId = (at: EpochMs): EntryId => uuidv7(at) as EntryId
export const newIconId = (at: EpochMs): IconId => uuidv7(at) as IconId

/** Embedded creation timestamp (first 48 bits), for tests and debugging. */
export function idTimestamp(id: string): EpochMs {
  return epochMs(parseInt(id.replaceAll('-', '').slice(0, 12), 16))
}
