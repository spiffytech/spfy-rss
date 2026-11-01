import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDatabase } from '../src/server/db'
import { loadFromDump } from '../src/server/import/load'
import { verifyImport } from '../src/server/import/verify'
import { entries, feeds, userPrefs, users } from '../src/server/db/schema'
import { epochMs } from '../src/shared/ids'

const b64 = (bytes: number[]) => ({ $bytes: Buffer.from(Uint8Array.from(bytes)).toString('base64') })

function writeDump(dir: string, tables: Record<string, unknown[]>): void {
  for (const [table, rows] of Object.entries(tables)) {
    writeFileSync(join(dir, `${table}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))
  }
}

/** Rows shaped exactly like dump.ts serializes Postgres output. */
function fixtureDump(): Record<string, unknown[]> {
  return {
    users: [
      { id: 1, username: 'spiffy', created_at: 1000 },
      { id: 2, username: 'test', created_at: 1001 },
    ],
    categories: [{ id: 10, user_id: 1, title: 'Tech', created_at: 2000 }],
    feeds: [
      {
        id: 100,
        user_id: 1,
        category_id: 10,
        title: 'Blog',
        feed_url: 'https://a.example/feed',
        site_url: 'https://a.example',
        etag_header: 'W/"x"',
        last_modified_header: 'Thu, 01 Jan 2026 00:00:00 GMT',
        checked_at: 5000,
        parsing_error_count: 2,
        created_at: 3000,
      },
    ],
    entries: [
      {
        id: 1000,
        user_id: 1,
        feed_id: 100,
        hash: 'h1',
        title: 'One',
        url: 'https://a.example/1',
        author: 'au',
        content: '<p>one</p>',
        published_at: 4000,
        created_at: 4001,
        changed_at: 4002,
        status: 'unread',
        starred: true,
        reading_time: 3,
        tags: ['x'],
      },
      {
        id: 1001,
        user_id: 1,
        feed_id: 100,
        hash: 'h2',
        title: 'Two',
        content: '<p>two</p>',
        published_at: 4100,
        created_at: 4101,
        changed_at: 4101,
        status: 'read',
        starred: false,
        reading_time: 0,
        tags: [],
      },
      // orphan: feed 999 has no feeds row (MF keeps these; import skips them)
      { id: 1002, user_id: 1, feed_id: 999, hash: 'h-orphan', title: 'Orphan', content: 'x', published_at: 4200, status: 'unread' },
    ],
    icons: [{ id: 7, mime_type: 'image/png', content: b64([1, 2, 3]) }],
    feed_icons: [{ feed_id: 100, icon_id: 7 }],
    entry_tombstones: [
      { feed_id: 100, hash: 'h-deleted', deleted_at: 6000 },
      { feed_id: 999, hash: 'h-orphan-deleted', deleted_at: 6001 },
    ],
  }
}

function makePrefsDb(path: string): void {
  // The OLD app's shape verbatim (src/server/lib/prefs.ts there).
  const db = new Database(path, { create: true })
  db.run(`
    CREATE TABLE IF NOT EXISTS user_prefs (
      user_id INTEGER NOT NULL,
      scope   TEXT    NOT NULL,
      prefs   TEXT    NOT NULL DEFAULT '{}',
      PRIMARY KEY (user_id, scope)
    );
  `)
  db.run("INSERT INTO user_prefs (user_id, scope, prefs) VALUES (1, 'user', '{\"hideEmptyFeeds\":true}')")
  db.run("INSERT INTO user_prefs (user_id, scope, prefs) VALUES (1, 'feed:100', '{\"viewMode\":\"list\"}')")
  db.run("INSERT INTO user_prefs (user_id, scope, prefs) VALUES (2, 'feed:999', '{}')") // orphan feed
  db.close()
}

function setup() {
  const dumpDir = mkdtempSync(join(tmpdir(), 'import-dump-'))
  writeDump(dumpDir, fixtureDump())
  const prefsDbPath = join(mkdtempSync(join(tmpdir(), 'import-prefs-')), 'prefs.sqlite')
  makePrefsDb(prefsDbPath)
  return { handle: openDatabase(':memory:'), dumpDir, prefsDbPath }
}

describe('Miniflux import', () => {
  test('load maps every table, remaps ids, and skips orphans', () => {
    const { handle, dumpDir, prefsDbPath } = setup()
    const report = loadFromDump({ handle, dumpDir, prefsDbPath, now: 9999 })
    expect(report.users).toBe(2)
    expect(report.categories).toBe(1)
    expect(report.feeds).toBe(1)
    expect(report.entries).toBe(2) // orphan entry skipped
    expect(report.stubs).toBe(1) // orphan tombstone skipped
    expect(report.icons).toBe(1)
    expect(report.feedIcons).toBe(1)
    expect(report.prefs).toBe(2) // orphan feed-scope pref skipped
    expect(report.skipped).toEqual({ orphanEntries: 1, orphanTombstones: 1, orphanPrefs: 1 })

    // times arrive as plain epoch-ms integers
    const feed = handle.db.select().from(feeds).all()[0]!
    expect(feed.createdAt).toBe(epochMs(3000))
    expect(feed.checkedAt).toBe(epochMs(5000))
    expect(feed.etagHeader).toBe('W/"x"')
  })

  test('tombstones become status=removed stubs — the resurrection guard', () => {
    const { handle, dumpDir, prefsDbPath } = setup()
    loadFromDump({ handle, dumpDir, prefsDbPath, now: 9999 })
    const stub = handle.db.select().from(entries).all().find((e) => e.hash === 'h-deleted')!
    expect(stub.status).toBe('removed')
    expect(stub.content).toBe('')
    expect(stub.title).toBe('')
    expect(stub.publishedAt).toBe(epochMs(6000)) // deleted_at seeds the stub's times
  })

  test('a re-run is idempotent: same ids, no duplicates', () => {
    const { handle, dumpDir, prefsDbPath } = setup()
    loadFromDump({ handle, dumpDir, prefsDbPath, now: 9999 })
    const feedIdBefore = handle.db.select().from(feeds).all()[0]!.id
    const countBefore = handle.db.select().from(entries).all().length
    loadFromDump({ handle, dumpDir, prefsDbPath, now: 12345 })
    const feedAfter = handle.db.select().from(feeds).all()[0]!
    expect(feedAfter.id).toBe(feedIdBefore)
    expect(handle.db.select().from(entries).all().length).toBe(countBefore)
  })

  test('prefs carry over with remapped ids and rewritten scopes', () => {
    const { handle, dumpDir, prefsDbPath } = setup()
    loadFromDump({ handle, dumpDir, prefsDbPath, now: 9999 })
    const rows = handle.db.select().from(userPrefs).all()
    const user = handle.db.select().from(users).all().find((u) => u.username === 'spiffy')!
    const feed = handle.db.select().from(feeds).all()[0]!
    const scopes = rows.map((r) => [r.userId, r.scope, r.prefs])
    expect(scopes).toContainEqual([user.id, 'user', '{"hideEmptyFeeds":true}'])
    expect(scopes).toContainEqual([user.id, `feed:${feed.id}`, '{"viewMode":"list"}'])
    expect(rows).toHaveLength(2)
  })

  test('the verification gate passes on a clean load and fails on drift', () => {
    const { handle, dumpDir, prefsDbPath } = setup()
    loadFromDump({ handle, dumpDir, prefsDbPath, now: 9999 })
    const good = verifyImport({ handle, dumpDir })
    expect(good.pass).toBe(true)
    expect(good.problems).toEqual([])
    expect(good.hashDiff).toEqual({ missingInDb: 0, extraInDb: 0 })
    expect(good.statusTotals.db).toEqual({ unread: 1, read: 1, removed: 1 })
    expect(good.starred).toEqual({ source: 1, db: 1 })
    expect(good.publishedRangeNonRemoved.source).toEqual([4000, 4100])

    // drift is caught: a vanished entry shows up in the hash diff
    handle.sqlite.run("DELETE FROM entries WHERE hash = 'h2'")
    const bad = verifyImport({ handle, dumpDir })
    expect(bad.pass).toBe(false)
    expect(bad.hashDiff.missingInDb).toBe(1)
  })
})
