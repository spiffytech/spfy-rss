/**
 * Miniflux → reader import CLI. Cutover order: stop Miniflux, `dump`, `load`,
 * `verify`, swap the service. The dump is the frozen source of truth.
 *
 *   MINIFLUX_DATABASE_URL=postgres://… bun run scripts/import-miniflux.ts dump
 *   bun run scripts/import-miniflux.ts load
 *   bun run scripts/import-miniflux.ts verify
 *
 * Env: MINIFLUX_DATABASE_URL (dump only, never committed), IMPORT_DIR
 * (default import-dump), READER_DB_PATH (default data/reader.sqlite),
 * PREFS_DB_PATH (default data/prefs.sqlite, load only).
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { openDatabase } from '../src/server/db'
import { dumpFromMiniflux } from '../src/server/import/dump'
import { loadFromDump } from '../src/server/import/load'
import { verifyImport } from '../src/server/import/verify'
import { repoRoot } from '../src/server/repo-root'

const command = process.argv[2]
const dumpDir = process.env.IMPORT_DIR ?? join(repoRoot, 'import-dump')
const dbPath = process.env.READER_DB_PATH ?? join(repoRoot, 'data', 'reader.sqlite')
const prefsDbPath = process.env.PREFS_DB_PATH ?? join(repoRoot, 'data', 'prefs.sqlite')

switch (command) {
  case 'dump': {
    const url = process.env.MINIFLUX_DATABASE_URL
    if (!url) {
      console.error('MINIFLUX_DATABASE_URL is required for dump')
      process.exit(2)
    }
    mkdirSync(dumpDir, { recursive: true })
    console.log(await dumpFromMiniflux({ databaseUrl: url, outDir: dumpDir }))
    break
  }
  case 'load': {
    const handle = openDatabase(dbPath)
    try {
      console.log(loadFromDump({ handle, dumpDir, prefsDbPath }))
    } finally {
      handle.sqlite.close()
    }
    break
  }
  case 'verify': {
    const handle = openDatabase(dbPath)
    try {
      const report = verifyImport({ handle, dumpDir })
      console.log(JSON.stringify(report, null, 2))
      if (!report.pass) process.exit(1)
    } finally {
      handle.sqlite.close()
    }
    break
  }
  default: {
    console.error('usage: import-miniflux.ts <dump|load|verify>')
    process.exit(2)
  }
}
