import { describe, expect, test } from 'bun:test'

import { parseFeedBody } from '../src/server/fetch/parse'
import { epochMs } from '../src/shared/ids'

const sha = (v: string) => new Bun.CryptoHasher('sha256').update(v).digest('hex')
const NOW = 1_750_000_000_000
const opts = { now: NOW, jitterSeconds: () => 0 }

const rssFeed = (items: string) => `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Blog</title>
    <link>https://a.example/</link>
    ${items}
  </channel>
</rss>`

describe('parse pipeline (feedsmith + quirks + MF hashes)', () => {
  test('RSS: MF hash chain end-to-end (MF vector guid "1234")', () => {
    const feed = parseFeedBody(
      rssFeed(`<item><title>One</title><guid isPermaLink="false">1234</guid></item>`),
      'https://a.example/feed',
      opts,
    )
    expect(feed.items[0]!.hash).toBe('03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4')
  })

  test('RSS: NB content selection stores the long html body while identity stays guid-based', () => {
    const feed = parseFeedBody(
      rssFeed(`<item>
        <title>One</title>
        <link>https://a.example/1</link>
        <guid isPermaLink="false">g1</guid>
        <description>short</description>
        <content:encoded><![CDATA[<p>long body here</p>]]></content:encoded>
      </item>`),
      'https://a.example/feed',
      opts,
    )
    const item = feed.items[0]!
    expect(item.hash).toBe(sha('g1'))
    expect(item.content).toBe('<p>long body here</p>')
    expect(item.url).toBe('https://a.example/1')
  })

  test('RSS: duplicate guids go through MF’s ladder (supersedes NB’s replacement)', () => {
    const feed = parseFeedBody(
      rssFeed(`<item>
        <guid isPermaLink="false">dup</guid>
        <title>A</title>
        <link>https://a.example/a</link>
      </item>
      <item>
        <guid isPermaLink="false">dup</guid>
        <title>B</title>
        <link>https://a.example/b</link>
      </item>`),
      'https://a.example/feed',
      opts,
    )
    expect(feed.items.map((i) => i.hash)).toEqual([sha('dup'), sha('dup|https://a.example/b')])
  })

  test('RSS: no guid → SHA256(raw url)', () => {
    const feed = parseFeedBody(
      rssFeed(`<item><title>One</title><link>https://a.example/post</link></item>`),
      'https://a.example/feed',
      opts,
    )
    expect(feed.items[0]!.hash).toBe(sha('https://a.example/post'))
  })

  test('mojibake repair applies before parsing', () => {
    const feed = parseFeedBody(
      rssFeed(`<item><title>Apple&acirc;&#128;&#153;s</title><guid isPermaLink="false">g</guid></item>`),
      'https://a.example/feed',
      opts,
    )
    expect(feed.items[0]!.title).toBe('Apple\u2019s')
  })

  test('malformed XML survives via control-char stripping', () => {
    const feed = parseFeedBody(
      rssFeed(`<item><title>One\u0007</title><guid isPermaLink="false">g</guid></item>`),
      'https://a.example/feed',
      opts,
    )
    expect(feed.items[0]!.title).toContain('One')
  })

  test('dates clamp per NB: 1999 stamps become the fetch time', () => {
    const feed = parseFeedBody(
      rssFeed(`<item><title>Old</title><guid isPermaLink="false">g</guid><pubDate>Fri, 01 Jan 1999 00:00:00 GMT</pubDate></item>`),
      'https://a.example/feed',
      opts,
    )
    expect(feed.items[0]!.publishedAt).toBe(epochMs(NOW))
  })

  test('Atom: identity is id first, link fallback', () => {
    const feed = parseFeedBody(
      `<?xml version="1.0" encoding="utf-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>T</title>
        <link rel="alternate" href="https://a.example/"/>
        <entry>
          <id>urn:x:1</id>
          <title>One</title>
          <link rel="alternate" href="https://a.example/1"/>
          <updated>2024-01-01T10:00:00Z</updated>
          <content type="html">&lt;p&gt;hi&lt;/p&gt;</content>
        </entry>
      </feed>`,
      'https://a.example/feed',
      opts,
    )
    expect(feed.items[0]!.hash).toBe(sha('urn:x:1'))
    expect(feed.items[0]!.url).toBe('https://a.example/1')
  })

  test('JSON Feed: trimmed identity chain', () => {
    const feed = parseFeedBody(
      JSON.stringify({
        version: 'https://jsonfeed.org/version/1',
        title: 'T',
        home_page_url: 'https://a.example/',
        items: [{ id: 'abc', url: 'https://a.example/1', content_html: '<p>hi</p>', date_published: '2024-01-01T10:00:00Z' }],
      }),
      'https://a.example/feed',
      opts,
    )
    expect(feed.items[0]!.hash).toBe(sha('abc'))
    expect(feed.items[0]!.content).toBe('<p>hi</p>')
  })
})

// feedsmith pluralizes the author and Dublin Core elements (`authors`,
// `dc.creators`), so reading the singular names silently yields nothing. These
// cover Miniflux's own chains, which the imported data came from.
describe('parse: author and Dublin Core fields', () => {
  const rss = (channel: string, items: string) => `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:googleplay="http://www.google.com/schemas/play-podcasts/1.0">
  <channel><title>Blog</title><link>https://a.example/</link>${channel}${items}</channel>
</rss>`

  const item = (body: string) => parseFeedBody(rss('', `<item><title>X</title><link>https://a.example/x</link>${body}</item>`), 'https://a.example/feed', opts).items[0]!

  test('RSS: a plain-text <author> is the submitter (lobste.rs shape)', () => {
    expect(item('<author>purplesyringa.moe via valdemar</author>').author).toBe('purplesyringa.moe via valdemar')
  })

  test('RSS: "email (Name)" keeps the name, as MF PersonName does', () => {
    expect(item('<author>plain@e.com (Plain Name)</author>').author).toBe('Plain Name')
  })

  test('RSS: dc:creator and itunes:author outrank <author> (MF order)', () => {
    expect(item('<author>plain@e.com</author><dc:creator>Alice</dc:creator>').author).toBe('Alice')
    expect(item('<dc:creator>Alice</dc:creator><itunes:author>Podcast Host</itunes:author>').author).toBe('Podcast Host')
  })

  test('RSS: falls back to the channel author (MF findFeedAuthor)', () => {
    const feed = parseFeedBody(
      rss('<managingEditor>me@e.com (Editor)</managingEditor>', '<item><title>X</title><link>https://a.example/x</link></item>'),
      'https://a.example/feed',
      opts,
    )
    expect(feed.items[0]!.author).toBe('Editor')
  })

  test('RSS: dc:date and dc:title are read', () => {
    const one = item('<dc:date>2025-01-02T03:04:05Z</dc:date><dc:language>en</dc:language><dc:title>Dublin</dc:title>')
    expect(one.publishedAt).toBe(epochMs(Date.parse('2025-01-02T03:04:05Z')))
    expect(one.title).toBe('Dublin')
  })

  test('RDF: item dc:creator, falling back to the channel', () => {
    const rdf = (channel: string, body: string) => `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://a.example/"><title>Blog</title><link>https://a.example/</link>${channel}</channel>
  <item rdf:about="https://a.example/x"><title>X</title><link>https://a.example/x</link><description>d</description>${body}</item>
</rdf:RDF>`
    const parse = (xml: string) => parseFeedBody(xml, 'https://a.example/feed', opts).items[0]!
    expect(parse(rdf('', '<dc:creator>Bob</dc:creator>')).author).toBe('Bob')
    expect(parse(rdf('<dc:creator>Chan</dc:creator>', '')).author).toBe('Chan')
  })
})

// Atom `type="html"` titles are HTML, and publishers escape them: the XML layer
// decodes one level, leaving a literal `&#8217;` that would otherwise be shown
// as text in the reader (brucelawson.co.uk).
describe('parse: text encoding', () => {
  test('Atom: type=html titles and feed title are entity-decoded', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="html">Bruce Lawson&amp;#039;s personal site</title>
  <link href="https://brucelawson.co.uk/"/>
  <entry>
    <title type="html">EU, EU, It&amp;#8217;s off to work we go</title>
    <link href="https://brucelawson.co.uk/2026/eu-eu-its-off-to-work-we-go/"/>
    <id>tag:brucelawson.co.uk,2026:1</id>
    <updated>2025-01-02T03:04:05Z</updated>
  </entry>
</feed>`
    const feed = parseFeedBody(xml, 'https://brucelawson.co.uk/feed/atom/', opts)
    expect(feed.title).toBe("Bruce Lawson's personal site") // &#039; is U+0027
    expect(feed.items[0]!.title).toBe('EU, EU, It\u2019s off to work we go')
  })

  test('Atom: a plain-text title is left alone', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Plain</title>
  <entry><title>Rust &amp; C++</title><id>1</id><link href="https://a.example/1"/></entry>
</feed>`
    expect(parseFeedBody(xml, 'https://a.example/feed', opts).items[0]!.title).toBe('Rust & C++')
  })
})
