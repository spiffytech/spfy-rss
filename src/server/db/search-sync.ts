/**
 * FTS5 maintenance for the external-content index `entries_fts`
 * (`content='entries'` maps onto entries(title, content) by name).
 *
 * App-maintained, not trigger-maintained: the only entry write sites are the
 * Miniflux import and the fetch pipeline, and both call in here. External
 * content updates need the OLD indexed values to delete the previous index
 * entry, hence the before/after shape.
 */
import type { Database } from 'bun:sqlite'

export type SearchRow = {
  rowid: number
  title: string
  content: string
}

/**
 * Sync the index for one entry row: `before` = previously indexed values (null
 * = new row), `after` = current values (null = removed from index). A change
 * is delete-old-then-insert-new.
 */
export function syncEntrySearch(
  db: Database,
  before: SearchRow | null,
  after: SearchRow | null,
): void {
  if (before) {
    db.run(
      `INSERT INTO entries_fts(entries_fts, rowid, title, content) VALUES('delete', ?, ?, ?)`,
      [before.rowid, before.title, before.content],
    )
  }
  if (after) {
    db.run(`INSERT INTO entries_fts(rowid, title, content) VALUES(?, ?, ?)`, [
      after.rowid,
      after.title,
      after.content,
    ])
  }
}

/** Full reindex from the entries table (maintenance / recovery). */
export function rebuildEntrySearch(db: Database): void {
  db.run(`INSERT INTO entries_fts(entries_fts) VALUES('rebuild')`)
}
