import { expect, test } from 'bun:test'
import type { SQLQueryBindings } from 'bun:sqlite'

import { openDatabase, type ReaderHandle } from '../src/server/db'
import { categories } from '../src/server/db/schema'
import { rebuildEntrySearch } from '../src/server/db/search-sync'
import {
  getAllFeedPrefs,
  markEntries,
  setFeedPrefs,
  setStarred,
  setUserPrefs,
} from '../src/server/query/mutations'
import { panel, queryView } from '../src/server/query/views'
import {
  epochMs,
  newCategoryId,
  newEntryId,
  newFeedId,
  newUserId,
  type EntryId,
  type FeedId,
  type UserId,
} from '../src/shared/ids'
import { resolveViewFilter } from '../src/shared/prefs'

const NOW = 1_750_000_000_000

const view = (db: Parameters<typeof queryView>[0], opts: Parameters<typeof queryView>[1]) =>
  queryView(db, opts).entries

type Fixture = {
  handle: ReaderHandle
  userId: UserId
  feedA: FeedId
  feedB: FeedId
  stubId: EntryId
}

function setup(): Fixture {
  const handle = openDatabase(':memory:')
  const userId = newUserId(epochMs(NOW))
  handle.sqlite.run(
    'INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)',
    [userId, 'spiffy', 'h', NOW],
  )
  const catId = newCategoryId(epochMs(NOW))
  handle.sqlite.run('INSERT INTO categories (id, user_id, title, created_at) VALUES (?, ?, ?, ?)', [
    catId,
    userId,
    'Tech',
    NOW,
  ])
  const feedA = newFeedId(epochMs(NOW))
  const feedB = newFeedId(epochMs(NOW))
  handle.sqlite.run(
    'INSERT INTO feeds (id, user_id, category_id, title, feed_url, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [feedA, userId, catId, 'Feed A', 'https://a.example/feed', NOW],
  )
  handle.sqlite.run(
    'INSERT INTO feeds (id, user_id, category_id, title, feed_url, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [feedB, userId, catId, 'Feed B', 'https://b.example/feed', NOW],
  )

  const add = (
    id: EntryId,
    feedId: FeedId,
    over: Partial<{
      title: string
      content: string
      status: string
      starred: number
      author: string
      tags: string
    }>,
  ) => {
    handle.sqlite.run(
      `INSERT INTO entries (id, user_id, feed_id, hash, title, content, published_at, created_at, changed_at, status, starred, reading_time, tags, author)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        id,
        userId,
        feedId,
        `h-${id}`,
        over.title ?? 'Title',
        over.content ?? '<p>body</p>',
        NOW,
        NOW,
        NOW,
        over.status ?? 'unread',
        over.starred ?? 0,
        over.tags ?? '[]',
        over.author ?? null,
      ],
    )
  }

  const e1 = newEntryId(epochMs(NOW)) // unread A
  const e2 = newEntryId(epochMs(NOW + 1)) // read A
  const e3 = newEntryId(epochMs(NOW + 2)) // unread B
  const stubId = newEntryId(epochMs(NOW + 4)) // removed A
  add(e1, feedA, { title: 'alpha launch', content: '<p>first post</p>' })
  add(e2, feedA, {
    title: 'beta reveal',
    content: '<p>alpha content</p>',
    status: 'read',
    author: 'Dana',
  })
  add(e3, feedB, { title: 'gamma update', content: '<p>third</p>', tags: '["spoiler"]' })
  add(stubId, feedA, { title: '', content: '', status: 'removed' })

  // the fixture inserts bypass the app-maintained write path — index explicitly
  rebuildEntrySearch(handle.sqlite)
  return { handle, userId, feedA, feedB, stubId }
}

test('default view: unread only, soft-deleted rows absent', () => {
  const { handle, userId, stubId } = setup()
  const rows = view(handle.db, { userId, filter: {} })
  const ids = rows.map((r) => r.id)
  expect(ids).toHaveLength(2) // e1 + e3; e2 read, stub removed
  expect(ids).not.toContain(stubId)
  expect(rows.map((r) => r.title).sort()).toEqual(['alpha launch', 'gamma update'])
})

test('hideReadItems=false brings read rows back', () => {
  const { handle, userId } = setup()
  const rows = view(handle.db, { userId, filter: { hideReadItems: false } })
  expect(rows.map((r) => r.title).sort()).toEqual(['alpha launch', 'beta reveal', 'gamma update'])
})

test('resolveViewFilter folds in the feed prefs so the first window honors them', () => {
  const { handle, userId, feedA } = setup()
  const prefs = { [feedA]: { sort: 'newest' as const, hideReadItems: false } }
  // The bare identity filter from the URL: defaults would be oldest + unread-only.
  expect(
    view(handle.db, { userId, filter: resolveViewFilter({ feedId: feedA }, {}) }).map(
      (r) => r.title,
    ),
  ).toEqual(['alpha launch'])
  // With the feed's saved prefs the same request comes back newest-first with read rows.
  expect(
    view(handle.db, { userId, filter: resolveViewFilter({ feedId: feedA }, prefs) }).map(
      (r) => r.title,
    ),
  ).toEqual(['beta reveal', 'alpha launch'])
})

test('feed, category and starred scopes', () => {
  const { handle, userId, feedA, feedB } = setup()
  expect(view(handle.db, { userId, filter: { feedId: feedA } }).map((r) => r.title)).toEqual([
    'alpha launch',
  ])
  expect(view(handle.db, { userId, filter: { feedId: feedB } }).map((r) => r.title)).toEqual([
    'gamma update',
  ])
  const categoryId = handle.db.select().from(categories).all()[0]!.id
  expect(view(handle.db, { userId, filter: { categoryId } })).toHaveLength(2)
  setStarred(handle.db, {
    userId,
    entryIds: view(handle.db, { userId, filter: {} }).map((r) => r.id),
    starred: true,
  })
  expect(view(handle.db, { userId, filter: { starred: true } })).toHaveLength(2)
})

test('search spans read and unread by default; toggle narrows to unread', () => {
  const { handle, userId } = setup()
  const all = view(handle.db, { userId, filter: { search: 'alpha' } })
  expect(all.map((r) => r.title).sort()).toEqual(['alpha launch', 'beta reveal']) // 'alpha' in title + content
  const unread = view(handle.db, { userId, filter: { search: 'alpha', searchStatus: 'unread' } })
  expect(unread.map((r) => r.title)).toEqual(['alpha launch'])
})

test('search lists unread matches first, newest-first within each bucket', () => {
  const { handle, userId } = setup()
  const rows = view(handle.db, { userId, filter: { search: 'alpha' } })
  expect(rows.map((r) => r.status)).toEqual(['unread', 'read'])
  expect(rows.map((r) => r.title)).toEqual(['alpha launch', 'beta reveal'])
})

test('search pages across the unread/read boundary with no skips or repeats', () => {
  const { handle, userId } = setup()
  const page1 = queryView(handle.db, { userId, filter: { search: 'alpha' }, limit: 1 })
  expect(page1.entries.map((r) => r.title)).toEqual(['alpha launch'])
  expect(page1.nextCursor?.bucket).toBe(0)
  const page2 = queryView(handle.db, {
    userId,
    filter: { search: 'alpha' },
    limit: 1,
    cursor: page1.nextCursor,
  })
  expect(page2.entries.map((r) => r.title)).toEqual(['beta reveal'])
  expect(page2.nextCursor).toBeNull()
})

test('search: exclusion-only input and type-ahead prefixes work', () => {
  const { handle, userId } = setup()
  const minusOne = view(handle.db, { userId, filter: { search: '-gamma', hideReadItems: false } })
  expect(minusOne.map((r) => r.title).sort()).toEqual(['alpha launch', 'beta reveal']) // everything except gamma rows
  const prefix = view(handle.db, { userId, filter: { search: 'alp' } })
  expect(prefix.map((r) => r.title).sort()).toEqual(['alpha launch', 'beta reveal'])
})

test('counters share the list predicate exactly', () => {
  const { handle, userId, feedA } = setup()
  const p = panel(handle.db, { userId, hideEmptyFeeds: false })
  const listUnread = view(handle.db, { userId, filter: { feedId: feedA } }).length
  expect(p.counters[feedA]).toBe(listUnread) // counters share the list predicate exactly
  expect(p.counters[feedA!]).toBe(1)
  // Category totals are the sum of these counters on the client; the payload
  // carries no separate total to drift from them.
  expect(p.categories).toHaveLength(1)
})

test('markEntries touches exactly the passed ids and never removed rows', () => {
  const { handle, userId, stubId } = setup()
  const visible = view(handle.db, { userId, filter: {} }).map((r) => r.id)
  const changed = markEntries(handle.db, { userId, entryIds: visible, status: 'read' })
  expect(changed).toBe(2)
  // stubs are never touched
  const changedStub = markEntries(handle.db, { userId, entryIds: [stubId], status: 'read' })
  expect(changedStub).toBe(0)
})

test('a page returns each row with its body', () => {
  // One request, one query: the body is a column of the row, not a second call
  // per card (a page of a hundred averages 41 KB of bodies).
  const { handle, userId } = setup()
  const [first] = view(handle.db, { userId, filter: {} })
  expect(first!.content).toBe('<p>first post</p>')
  expect(first!.feedBaseUrl).toBeTruthy()
})

test("panel keeps the view's feed in the sidebar even with nothing unread", () => {
  const { handle, userId, feedA, feedB } = setup()
  // Read everything: both feeds now have nothing unread, so hideEmptyFeeds hides them.
  markEntries(handle.db, {
    userId,
    entryIds: view(handle.db, { userId, filter: {} }).map((r) => r.id),
    status: 'read',
  })
  const none = panel(handle.db, { userId, hideEmptyFeeds: true })
  expect(none.feeds.find((f) => f.id === feedA)).toBeUndefined()
  expect(none.feeds.find((f) => f.id === feedB)).toBeUndefined()

  // …but the view's own feed stays in the list, so the sidebar can keep it
  // selected and the header can name it.
  const viewing = panel(handle.db, { userId, hideEmptyFeeds: true, currentFeed: feedA })
  expect(viewing.feeds.find((f) => f.id === feedA)?.title).toBe('Feed A')
  expect(viewing.feeds.find((f) => f.id === feedB)).toBeUndefined()
})

test('user prefs round-trip and merge', () => {
  const { handle, userId, feedB } = setup()
  setUserPrefs(handle.db, userId, { hideEmptyFeeds: true })
  const merged = setUserPrefs(handle.db, userId, { disabledAutoReadFeeds: [] })
  expect(merged.hideEmptyFeeds).toBe(true)
  // empty feed B out (mark its entry read), then the panel hides it
  markEntries(handle.db, {
    userId,
    entryIds: view(handle.db, { userId, filter: { feedId: feedB } }).map((r) => r.id),
    status: 'read',
  })
  const p = panel(handle.db, { userId, hideEmptyFeeds: true })
  expect(p.feeds).toHaveLength(1)
  expect(p.feeds[0]!.id).not.toBe(feedB)
})

test('a favorite with nothing unread is still resolvable for the home page', () => {
  const { handle, userId, feedB } = setup()
  // Everything in feed B is read. The sidebar keeps hiding it (hideEmptyFeeds),
  // but the home page resolves links from `allFeeds`, so the favorite survives.
  markEntries(handle.db, {
    userId,
    entryIds: view(handle.db, { userId, filter: { feedId: feedB } }).map((r) => r.id),
    status: 'read',
  })
  const snapshot = panel(handle.db, { userId, hideEmptyFeeds: true })
  expect(snapshot.feeds.find((f) => f.id === feedB)).toBeUndefined()
  expect(snapshot.allFeeds.find((f) => f.id === feedB)?.title).toBe('Feed B')
  expect(snapshot.counters[feedB] ?? 0).toBe(0)
})

test('feed prefs round-trip, including the home-page favorite flag', () => {
  const { handle, userId, feedB } = setup()
  setFeedPrefs(handle.db, userId, feedB, { favorite: true })
  // Merges with later patches rather than replacing them.
  setFeedPrefs(handle.db, userId, feedB, { sort: 'newest' })
  expect(getAllFeedPrefs(handle.db, userId)[feedB]).toMatchObject({
    favorite: true,
    sort: 'newest',
  })
  // Unfavoriting is a patch too, and the feed does not move category.
  setFeedPrefs(handle.db, userId, feedB, { favorite: false })
  expect(getAllFeedPrefs(handle.db, userId)[feedB]?.favorite).toBe(false)
})

test('view windows page by keyset: no skips, no repeats, even on timestamp ties', () => {
  const { handle, userId } = setup()
  // every fixture row shares published_at = NOW, so every seam is the id
  // tie-break — the harshest case for the (published_at, id) keyset.
  const opts = { userId, filter: { hideReadItems: false } }
  const page1 = queryView(handle.db, { ...opts, limit: 2 })
  expect(page1.entries).toHaveLength(2)
  expect(page1.nextCursor).not.toBeNull()
  const page2 = queryView(handle.db, { ...opts, limit: 2, cursor: page1.nextCursor })
  // removed rows never appear: 3 visible total, so page 2 is the tail
  expect(page2.entries).toHaveLength(1)
  expect(page2.nextCursor).toBeNull() // end of the view — do NOT fetch again
  const ids = [...page1.entries, ...page2.entries].map((e) => e.id)
  expect(new Set(ids).size).toBe(3) // no repeats across the seam, nothing skipped
})
