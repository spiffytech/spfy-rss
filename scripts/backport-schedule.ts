/**
 * One-shot backfill: seed the reader's scheduler from the retired Miniflux
 * instance's own scheduling state.
 *
 * The old supervisor wrote `feeds.next_check_at` into Miniflux's Postgres on a
 * 1-minute loop — those values ARE the learned bell data. Without this backfill
 * the reader's fresh scheduler sees every feed as "never scheduled" and drains
 * the entire backlog in one burst instead of resuming the established schedule
 * (the old targets are spread across the day; most are still in the future).
 *
 * The old target also becomes `fetch_after_at`, the not-before floor, until the
 * feed's first fetch: that keeps a `Retry-After` the old scheduler had already
 * honoured from being eroded by a freshly computed bell. The next fetch
 * overwrites the floor from the response, as usual.
 *
 * Matching is by `feed_url` (the import's natural key). Unmatched feeds — URL
 * variants, or feeds dropped by the account surgery — simply plan their own
 * target on the first tick, which is exactly the old behaviour for a new feed.
 *
 * Standalone on purpose (bun:sqlite only, no app imports) so the same script
 * runs against a local file and inside the deployed container:
 *
 *   local: bun run scripts/backport-schedule.ts payload.json [dbPath]
 *   prod:  cat payload.json | uc -c homelab-spfy exec -T spfy-rss -- \
 *            sh -c 'cat > /tmp/backfill.ts && bun /tmp/backfill.ts'
 *          (payload on stdin; DB path from READER_DB_PATH)
 */
import { Database } from 'bun:sqlite'

type Row = { url: string; checked_at: number; next_check_at: number }

const dbPath =
  process.env.READER_DB_PATH ?? new URL('../data/reader.sqlite', import.meta.url).pathname
const argPath = process.argv[2]
const payload = (argPath ? await Bun.file(argPath).json() : await Bun.stdin.json()) as {
  rows: Row[]
}

if (!payload?.rows?.length) {
  console.error('no rows in payload')
  process.exit(1)
}

const db = new Database(dbPath)
const now = Date.now()

const findFeed = db.query<{ id: string }, [string]>('SELECT id FROM feeds WHERE feed_url = ?')
const schedule = db.prepare(
  'UPDATE feeds SET next_check_at = ?, fetch_after_at = ? WHERE id = ? AND next_check_at IS NULL',
)

let matched = 0
let alreadyScheduled = 0
let unmatched = 0
let future = 0

db.transaction(() => {
  for (const row of payload.rows) {
    const feed = findFeed.get(row.url)
    if (!feed) {
      unmatched++
      continue
    }
    const changed = schedule.run(row.next_check_at, row.next_check_at, feed.id).changes
    if (changed === 0) {
      alreadyScheduled++
      continue
    }
    matched++
    if (row.next_check_at > now) future++
  }
})()

const due = db
  .query<{ n: number }, [number]>(
    'SELECT count(*) AS n FROM feeds WHERE next_check_at IS NOT NULL AND next_check_at <= ?',
  )
  .get(now)!.n
const scheduled = db
  .query<{ n: number }, []>('SELECT count(*) AS n FROM feeds WHERE next_check_at IS NOT NULL')
  .get()!.n
const total = db.query<{ n: number }, []>('SELECT count(*) AS n FROM feeds').get()!.n
db.close()

console.log(
  JSON.stringify(
    {
      db: dbPath,
      payloadRows: payload.rows.length,
      matched,
      future,
      unmatched,
      alreadyScheduled,
      scheduled,
      totalFeeds: total,
      dueNow: due,
    },
    null,
    2,
  ),
)
