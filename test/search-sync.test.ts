import { describe, expect, test } from 'bun:test'
import type { SQLQueryBindings } from 'bun:sqlite'

import { openDatabase } from '../src/server/db'
import { rebuildEntrySearch, syncEntrySearch, type SearchRow } from '../src/server/db/search-sync'
import { entries } from '../src/server/db/schema'
import { epochMs, newCategoryId, newEntryId, newFeedId, newUserId } from '../src/shared/ids'

const NOW = epochMs(1_750_000_000_000)

function setup() {
  const handle = openDatabase(':memory:')
  const userId = newUserId(NOW)
  const categoryId = newCategoryId(NOW)
  const feedId = newFeedId(NOW)
  handle.sqlite.run(
    'INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)',
    [userId, 'spiffy', 'argon2id$fake', NOW],
  )
  handle.sqlite.run('INSERT INTO categories (id, user_id, title, created_at) VALUES (?, ?, ?, ?)', [
    categoryId,
    userId,
    'Tech',
    NOW,
  ])
  handle.sqlite.run(
    'INSERT INTO feeds (id, user_id, category_id, title, feed_url, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [feedId, userId, categoryId, 'Blog', 'https://example.com/feed.xml', NOW],
  )
  return { ...handle, userId, feedId }
}

function addEntry(
  sqlite: ReturnType<typeof openDatabase>['sqlite'],
  title: string,
  content: string,
): SearchRow {
  const id = newEntryId(NOW)
  sqlite.run(
    `INSERT INTO entries (id, user_id, feed_id, hash, title, content, published_at, created_at, changed_at)
     SELECT ?, user_id, id, ?, ?, ?, ?, ?, ? FROM feeds LIMIT 1`,
    [id, `hash-${title}`, title, content, NOW, NOW, NOW],
  )
  return sqlite
    .query<SearchRow, SQLQueryBindings[]>('SELECT rowid, title, content FROM entries WHERE id = ?')
    .get(id)!
}

function match(sqlite: ReturnType<typeof openDatabase>['sqlite'], term: string): number[] {
  return sqlite
    .query<{ rowid: number }, SQLQueryBindings[]>(
      'SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?',
    )
    .all(term)
    .map((r) => r.rowid)
}

describe('entries_fts app-maintained sync', () => {
  test('indexed rows match; unindexed rows do not', () => {
    const { sqlite } = setup()
    const row = addEntry(sqlite, 'alpha launch', '<p>alpha content</p>')
    expect(match(sqlite, 'alpha')).toEqual([])
    syncEntrySearch(sqlite, null, row)
    expect(match(sqlite, 'alpha')).toEqual([row.rowid])
    expect(match(sqlite, 'launch')).toEqual([row.rowid])
    expect(match(sqlite, 'content')).toEqual([row.rowid])
  })

  test('updates drop old terms and pick up new ones', () => {
    const { sqlite } = setup()
    const before = addEntry(sqlite, 'alpha launch', '<p>alpha content</p>')
    syncEntrySearch(sqlite, null, before)
    sqlite.run('UPDATE entries SET title = ? WHERE rowid = ?', ['beta reveal', before.rowid])
    const after = sqlite
      .query<SearchRow, SQLQueryBindings[]>(
        'SELECT rowid, title, content FROM entries WHERE rowid = ?',
      )
      .get(before.rowid)!
    syncEntrySearch(sqlite, before, after)
    expect(match(sqlite, 'launch')).toEqual([]) // old title term gone
    expect(match(sqlite, 'beta')).toEqual([before.rowid]) // new title term live
    expect(match(sqlite, 'alpha')).toEqual([before.rowid]) // survives via content
  })

  test('removal from the index leaves the row searchable nowhere', () => {
    const { sqlite } = setup()
    const row = addEntry(sqlite, 'alpha launch', '<p>alpha content</p>')
    syncEntrySearch(sqlite, null, row)
    syncEntrySearch(sqlite, row, null)
    expect(match(sqlite, 'alpha')).toEqual([])
  })

  test('rebuild restores the index from the entries table', () => {
    const { sqlite } = setup()
    const row = addEntry(sqlite, 'alpha launch', '<p>alpha content</p>')
    syncEntrySearch(sqlite, null, row)
    sqlite.run("INSERT INTO entries_fts(entries_fts) VALUES('delete-all')")
    expect(match(sqlite, 'alpha')).toEqual([])
    rebuildEntrySearch(sqlite)
    expect(match(sqlite, 'alpha')).toEqual([row.rowid])
  })

  test('the FTS5 dialect the search translator emits: phrase, exclusion, prefix', () => {
    // User input grammar allows `-term`; FTS5 does not (it parses as a broken
    // column filter), so the translator maps `-term` -> `NOT term`. These
    // assertions pin the dialect the translator may emit.
    const { sqlite } = setup()
    const a = addEntry(sqlite, 'alpha launch', '<p>first post</p>')
    const b = addEntry(sqlite, 'beta reveal', '<p>alpha content</p>')
    syncEntrySearch(sqlite, null, a)
    syncEntrySearch(sqlite, null, b)
    expect(match(sqlite, '"alpha launch"')).toEqual([a.rowid])
    expect(match(sqlite, 'alpha NOT launch')).toEqual([b.rowid])
    expect(match(sqlite, 'alp*')).toEqual([a.rowid, b.rowid])
  })
})
