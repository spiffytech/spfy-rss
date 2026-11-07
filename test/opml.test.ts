import { describe, expect, test } from 'bun:test'

import { openDatabase } from '../src/server/db'
import { categories, feeds, users } from '../src/server/db/schema'
import { exportOpml, importOpml, parseSubscriptions } from '../src/server/opml'
import { epochMs, newUserId, type UserId } from '../src/shared/ids'

const NOW = epochMs(1_750_000_000_000)

function setup(): { handle: ReturnType<typeof openDatabase>; userId: UserId } {
  const handle = openDatabase(':memory:')
  const userId = newUserId(NOW)
  handle.db
    .insert(users)
    .values({ id: userId, username: 'spiffy', passwordHash: 'h', createdAt: NOW })
    .run()
  return { handle, userId }
}

const nested = `<?xml version="1.0"?>
<opml version="2.0">
  <head><title>Subscriptions</title></head>
  <body>
    <outline text="Loose" title="Loose" type="rss" xmlUrl="https://loose.example/feed.xml" htmlUrl="https://loose.example/"/>
    <outline text="Tech" title="Tech">
      <outline text="Blogs" title="Blogs">
        <outline text="Deep" title="Deep" type="rss" xmlUrl="https://deep.example/rss" htmlUrl="https://deep.example/"/>
      </outline>
      <outline text="Direct" title="Direct" type="rss" xmlUrl="not a url"/>
      <outline text="News" title="News" type="rss" xmlUrl="https://news.example/feed"/>
    </outline>
  </body>
</opml>`

describe('parseSubscriptions', () => {
  test('flattens nested folders into joined flat names and keeps top-level feeds loose', () => {
    const parsed = parseSubscriptions(nested)
    if (!parsed.ok) throw new Error('parse failed')
    expect(parsed.subscriptions).toEqual([
      {
        title: 'Loose',
        feedUrl: 'https://loose.example/feed.xml',
        siteUrl: 'https://loose.example/',
        folder: null,
      },
      {
        title: 'Deep',
        feedUrl: 'https://deep.example/rss',
        siteUrl: 'https://deep.example/',
        folder: 'Tech / Blogs',
      },
      { title: 'Direct', feedUrl: 'not a url', siteUrl: null, folder: 'Tech' },
      { title: 'News', feedUrl: 'https://news.example/feed', siteUrl: null, folder: 'Tech' },
    ])
  })

  test('rejects a non-OPML document', () => {
    expect(parseSubscriptions('<not-opml>')).toEqual({ ok: false })
  })
})

describe('importOpml', () => {
  test('creates flat folders, skips invalid URLs, and queues every feed for fetching', () => {
    const { handle, userId } = setup()
    const result = importOpml(handle, { userId, text: nested, now: NOW })
    expect(result).toEqual({ ok: true, imported: 3, existing: 0, invalid: 1 })

    const rows = handle.db.select().from(feeds).orderBy(feeds.title).all()
    expect(rows.map((row) => row.title)).toEqual(['Deep', 'Loose', 'News'])
    expect(rows.every((row) => row.nextCheckAt === NOW)).toBe(true)
    expect(rows.find((row) => row.title === 'Loose')!.categoryId).toBeNull()

    const folders = handle.db.select().from(categories).orderBy(categories.title).all()
    expect(folders.map((folder) => folder.title)).toEqual(['Tech', 'Tech / Blogs'])
    expect(rows.find((row) => row.title === 'News')!.categoryId).toBe(
      folders.find((folder) => folder.title === 'Tech')!.id,
    )
  })

  test('dedupes against existing feeds and within one file', () => {
    const { handle, userId } = setup()
    importOpml(handle, { userId, text: nested, now: NOW })
    const again = importOpml(handle, { userId, text: nested, now: NOW })
    expect(again).toEqual({ ok: true, imported: 0, existing: 3, invalid: 1 })
    expect(handle.db.select().from(feeds).all()).toHaveLength(3)
  })

  test('reports an invalid file without writing', () => {
    const { handle, userId } = setup()
    expect(importOpml(handle, { userId, text: 'nope', now: NOW })).toEqual({
      ok: false,
      reason: 'invalid_file',
    })
    expect(handle.db.select().from(feeds).all()).toHaveLength(0)
  })
})

describe('exportOpml', () => {
  test('round-trips folders and uncategorized feeds', () => {
    const { handle, userId } = setup()
    importOpml(handle, { userId, text: nested, now: NOW })

    const exported = exportOpml(handle, userId)
    expect(exported).toContain('<opml version="2.0">')
    expect(exported).toContain('Tech / Blogs')

    const parsed = parseSubscriptions(exported)
    if (!parsed.ok) throw new Error('export did not parse')
    const byTitle = new Map(parsed.subscriptions.map((sub) => [sub.title, sub]))
    expect(byTitle.get('Loose')?.folder).toBeNull()
    expect(byTitle.get('Deep')?.folder).toBe('Tech / Blogs')
    expect(byTitle.get('News')?.folder).toBe('Tech')
    expect(byTitle.get('News')?.feedUrl).toBe('https://news.example/feed')
  })
})
