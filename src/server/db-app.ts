/** The app's one DB handle (long-lived process, sync SQLite). */
import { join } from 'node:path'
import { openDatabase, type ReaderHandle } from './db'
import { repoRoot } from './repo-root'

let handle: ReaderHandle | null = null

/** READER_DB_PATH wins; otherwise `data/reader.sqlite` beside package.json. */
export function appDbPath(): string {
  return process.env.READER_DB_PATH ?? join(repoRoot, 'data', 'reader.sqlite')
}

export function appDb(): ReaderHandle {
  if (!handle) {
    handle = openDatabase(appDbPath())
  }
  return handle
}
