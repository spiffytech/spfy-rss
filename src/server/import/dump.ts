/**
 * Stage 1 of the Miniflux import: read Postgres read-only, write one JSONL
 * file per table. Runs against `MINIFLUX_DATABASE_URL` (env, never committed).
 *
 * Serialization: timestamps → epoch-ms numbers, bytea → `{"$bytes": base64}`,
 * text[] → plain arrays. Load/verify re-read exactly these files, so the dump
 * is the frozen source of truth for the cutover.
 */
import { join } from 'node:path'

export const DUMP_TABLES = [
  'users',
  'categories',
  'feeds',
  'entries',
  'icons',
  'feed_icons',
  'entry_tombstones',
] as const

export type DumpTable = (typeof DUMP_TABLES)[number]

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) return value.getTime()
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('base64') }
  return value
}

export async function dumpFromMiniflux(opts: {
  databaseUrl: string
  outDir: string
}): Promise<Record<string, number>> {
  const db = new Bun.SQL({ url: opts.databaseUrl, max: 1 })
  const counts: Record<string, number> = {}
  try {
    for (const table of DUMP_TABLES) {
      // Read-only by construction: plain SELECTs, ordered for diffable output.
      // Table names come from DUMP_TABLES (never user input) — `unsafe` is for
      // the identifier only; no values are interpolated.
      const rows = await db.unsafe(`SELECT * FROM ${table} ORDER BY 1`)
      const lines = rows.map((row: Record<string, unknown>) => JSON.stringify(row, jsonReplacer))
      await Bun.write(
        join(opts.outDir, `${table}.jsonl`),
        lines.join('\n') + (lines.length ? '\n' : ''),
      )
      counts[table] = rows.length
    }
  } finally {
    await db.close()
  }
  return counts
}
