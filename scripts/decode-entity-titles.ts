/**
 * One-off repair for the parser bug fixed in b4e8d29: Atom `type="html"` titles
 * carry HTML, and CDATA meant the XML layer decoded nothing, so entities like
 * `&#8217;` were stored literally and rendered as text. Feeds and authors were
 * affected by the same read; in practice only entry titles were hit.
 *
 * New fetches are correct, but rows already stored are not — and a conditional
 * refetch answers 304, which never reparses, so they would stay wrong forever.
 *
 * Dry run by default; `--apply` writes. Titles are in the search index, so the
 * FTS rows are rebuilt after a write.
 *
 * The runtime image ships no source, so bundle before running it in-container:
 *   bun build scripts/decode-entity-titles.ts --target bun --outfile /tmp/x.js
 *   cat /tmp/x.js | uc -c homelab-spfy service exec -T spfy-rss -- \
 *     sh -c 'cat > /tmp/x.js && bun /tmp/x.js --apply'
 */
import { Database } from 'bun:sqlite'
import { join } from 'node:path'

import { rebuildEntrySearch } from '../src/server/db/search-sync'
import { htmlUnescape } from '../src/server/fetch/quirks'
import { repoRoot } from '../src/server/repo-root'

const ENTITY = /&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/

const targets = [
  {
    label: 'entries.title',
    select: 'SELECT id, title AS value FROM entries',
    update: 'UPDATE entries SET title = ? WHERE id = ?',
  },
  {
    label: 'feeds.title',
    select: 'SELECT id, title AS value FROM feeds',
    update: 'UPDATE feeds SET title = ? WHERE id = ?',
  },
  {
    label: 'entries.author',
    select: "SELECT id, author AS value FROM entries WHERE author IS NOT NULL AND author != ''",
    update: 'UPDATE entries SET author = ? WHERE id = ?',
  },
]

const apply = process.argv.includes('--apply')
const dbPath = process.env.READER_DB_PATH ?? join(repoRoot, 'data', 'reader.sqlite')
const db = new Database(dbPath)

let total = 0
for (const target of targets) {
  const rows = db.query(target.select).all() as Array<{ id: string; value: string }>
  const changed = rows.filter(
    (row) => ENTITY.test(row.value) && htmlUnescape(row.value) !== row.value,
  )
  total += changed.length
  console.log(`${target.label}: ${changed.length} of ${rows.length} need decoding`)
  for (const row of changed.slice(0, 3)) {
    console.log(
      `   ${JSON.stringify(row.value.slice(0, 80))} -> ${JSON.stringify(htmlUnescape(row.value).slice(0, 80))}`,
    )
  }
  if (apply && changed.length > 0) {
    const statement = db.prepare(target.update)
    db.transaction(() => {
      for (const row of changed) statement.run(htmlUnescape(row.value), row.id)
    })()
    console.log(`   wrote ${changed.length}`)
  }
}

if (apply && total > 0) {
  rebuildEntrySearch(db)
  console.log('rebuilt the search index')
}
console.log(apply ? 'done' : `dry run: ${total} row(s) would change; pass --apply to write`)
