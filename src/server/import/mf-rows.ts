/**
 * Shape of the Miniflux rows as they land in the JSONL dump.
 *
 * `dump.ts` serializes Postgres rows with `SELECT *`, so rows carry more
 * columns than these — the schemas name exactly the fields the import
 * consumes and ignore the rest. Timestamps are epoch-ms numbers (dump
 * converts Date → number), bytea is `{"$bytes": "<base64>"}`, text[] is a
 * plain JSON array.
 */
import { z } from 'zod'

import type { EntryStatus } from '../../shared/ids'

/**
 * Miniflux's status vocabulary, in one place. `load` writes through it and
 * `verify` reads back through it; two copies could validate the wrong mapping.
 * An unknown status is treated as unread — visible, not silently dropped.
 */
export function normalizeStatus(status: string | null | undefined): EntryStatus {
  return status === 'read' ? 'read' : status === 'removed' ? 'removed' : 'unread'
}

const ts = z.number().nullable().optional()
const int = z.number().nullable().optional()

export const mfUser = z
  .object({
    id: z.number(),
    username: z.string(),
    created_at: ts,
  })
  .passthrough()

export const mfCategory = z
  .object({
    id: z.number(),
    user_id: z.number(),
    title: z.string(),
    created_at: ts,
  })
  .passthrough()

export const mfFeed = z
  .object({
    id: z.number(),
    user_id: z.number(),
    category_id: z.number(),
    title: z.string(),
    feed_url: z.string(),
    site_url: z.string().nullable().optional(),
    etag_header: z.string().nullable().optional(),
    last_modified_header: z.string().nullable().optional(),
    checked_at: ts,
    parsing_error_count: int,
    created_at: ts,
  })
  .passthrough()

export const mfEntry = z
  .object({
    id: z.number(),
    user_id: z.number(),
    feed_id: z.number(),
    hash: z.string(),
    title: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    author: z.string().nullable().optional(),
    content: z.string().nullable().optional(),
    published_at: z.number(),
    created_at: ts,
    changed_at: ts,
    status: z.string().nullable().optional(),
    starred: z.boolean().nullable().optional(),
    reading_time: int,
    tags: z.array(z.string()).nullable().optional(),
  })
  .passthrough()

export const mfIcon = z
  .object({
    id: z.number(),
    mime_type: z.string(),
    content: z.object({ $bytes: z.string() }),
  })
  .passthrough()

export const mfFeedIcon = z.object({ feed_id: z.number(), icon_id: z.number() }).passthrough()

export const mfTombstone = z
  .object({
    feed_id: z.number(),
    hash: z.string(),
    deleted_at: ts,
  })
  .passthrough()

export type MfUser = z.infer<typeof mfUser>
export type MfCategory = z.infer<typeof mfCategory>
export type MfFeed = z.infer<typeof mfFeed>
export type MfEntry = z.infer<typeof mfEntry>
export type MfIcon = z.infer<typeof mfIcon>
export type MfFeedIcon = z.infer<typeof mfFeedIcon>
export type MfTombstone = z.infer<typeof mfTombstone>
