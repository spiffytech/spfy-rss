/**
 * Database opener: bun:sqlite + Drizzle (query builder only, sync throughout).
 *
 * Pragmas are ported from the old prefs side-DB (our own code). Migrations run
 * from ./drizzle (drizzle-kit generate).
 *
 * `bun:sqlite` is externalized in vite.config.ts (ssr.external + the build's
 * rolldownOptions), so Vite leaves the import alone and Bun resolves it at
 * runtime.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Database } from 'bun:sqlite'

import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

function openBunDatabase(path: string): Database {
  // `create: true` makes the FILE, not its parent directory (the old prefs
  // side-DB mkdir'd first for exactly this reason).
  mkdirSync(dirname(path), { recursive: true })
  return new Database(path, { create: true })
}

export function openDatabase(path: string): {
  sqlite: Database
  db: ReturnType<typeof drizzle>
} {
  const sqlite = openBunDatabase(path)
  applyPragmas(sqlite)
  const db = drizzle(sqlite)
  // SQLite cannot drop/rebuild a table that children reference while foreign
  // keys are ON, and the PRAGMA is a no-op inside the migrator's transaction.
  // Toggle it around the migration run (trusted, app-owned SQL), then restore.
  sqlite.run('PRAGMA foreign_keys = OFF')
  try {
    // MIGRATIONS_DIR for the bundled server (import.meta.url lands inside
    // build/ chunks there, so the relative path stops resolving); dev default
    // unchanged.
    migrate(db, {
      migrationsFolder: process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL('../../../drizzle/', import.meta.url)),
    })
  } finally {
    sqlite.run('PRAGMA foreign_keys = ON')
  }
  return { sqlite, db }
}

export type ReaderHandle = ReturnType<typeof openDatabase>

function applyPragmas(db: Database): void {
  for (const [pragma, value] of [
    ['journal_mode', 'WAL'],
    ['synchronous', 'NORMAL'],
    ['foreign_keys', 'ON'],
    ['temp_store', 'MEMORY'],
    ['cache_size', '-64000'],
    ['mmap_size', '536870912'],
    ['page_size', '32768'],
    ['busy_timeout', '5000'],
    ['wal_autocheckpoint', '10000'],
  ] as const) {
    db.run(`PRAGMA ${pragma} = ${value}`)
  }
}
