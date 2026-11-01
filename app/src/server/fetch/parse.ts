/**
 * Feed parsing: feedsmith as the base parser, then the NewsBlur quirk layer
 * (mojibake repair, date clamping, entry cap, content selection) and
 * Miniflux's per-format identity chains (hash.ts) over the normalized items.
 *
 * The identity inputs (guid, raw url, resolved url, final title, MF-chain
 * content) mirror Miniflux's adapter field choices so that hashes recomputed
 * at refetch equal the values the import carried over.
 */
import { parseFeed } from 'feedsmith'

import { assertNever } from '../../shared/assert'
import { epochMs, type EpochMs } from '../../shared/ids'
import { atomEntryHash, jsonEntryHash, rdfEntryHash, rssEntryHashes, type RssItemIdentity } from '../reader/hash'
import { capEntries, chooseContent, clampStoryDate, htmlUnescape, preprocessFeedEncoding } from './quirks'

export type ParsedItem = {
  hash: string
  title: string
  url: string | null
  author: string | null
  content: string
  publishedAt: EpochMs
  tags: string[]
}

export type ParsedFeed = {
  title: string
  siteUrl: string | null
  /** Feed-declared icon (RSS image/logo, Atom logo/icon, JSON icon). */
  iconUrl: string | null
  items: ParsedItem[]
}

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec => (v && typeof v === 'object' ? (v as Rec) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const textOf = (v: unknown): string => {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object') return str((v as Rec).value ?? (v as Rec).content ?? (v as Rec).text ?? '')
  return ''
}
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
/** First non-empty string in a feedsmith field. feedsmith pluralizes Dublin
 *  Core and author elements into arrays (`dc.creators`, `authors`), so every
 *  read of those must go through this. */
const first = (v: unknown): string => arr(v).map((x) => str(x)).find((x) => x !== '') ?? ''
/** feedsmith's person shape (`{ name, email }`), mirroring Miniflux's
 *  PersonName: the name wins, the address is the fallback. */
const personName = (v: unknown): string => str(rec(v).name) || str(rec(v).email)
const dateOf = (v: unknown): Date | null => {
  if (v instanceof Date) return v
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

function resolveUrl(base: string | null, url: string): string {
  if (url === '') return ''
  try {
    return new URL(url, base ?? undefined).toString()
  } catch {
    return url
  }
}

function truncateHtmlText(html: string, limit: number): string {
  const text = htmlUnescape(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
  return text.slice(0, limit)
}

function stripControlChars(xml: string): string {
  // XML 1.0 forbids most C0 controls; dropping them rescues malformed feeds.
  return xml.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
}

function guidText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  return textOf(value).trim()
}

function firstAlternateLink(links: unknown): string {
  for (const link of arr(links)) {
    const l = rec(link)
    const rel = str(l.rel).toLowerCase()
    const href = str(l.href ?? l.url)
    if (href !== '' && (rel === 'alternate' || rel === '')) return href.trim()
  }
  return ''
}

type ParseOptions = { now?: number | undefined; jitterSeconds?: (() => number) | undefined }

export function parseFeedBody(rawXml: string, feedUrl: string, opts: ParseOptions = {}): ParsedFeed {
  const now = opts.now ?? Date.now()
  const jitter = opts.jitterSeconds ?? (() => Math.floor(Math.random() * 60))
  const fixed = preprocessFeedEncoding(rawXml)

  let parsed: unknown
  try {
    parsed = parseFeed(fixed)
  } catch {
    // Malformed-XML tolerance (NewsBlur parity): strip illegal control chars
    // and try again before giving up.
    parsed = parseFeed(stripControlChars(fixed))
  }

  const wrapped = rec(parsed)
  const inner = wrapped.feed
  const kind = str(wrapped.format)
  switch (kind) {
    case 'rss':
      return parseRss(inner, feedUrl, now, jitter)
    case 'atom':
      return parseAtom(inner, feedUrl, now, jitter)
    case 'json':
      return parseJson(inner, feedUrl, now, jitter)
    case 'rdf':
      return parseRdf(inner, feedUrl, now, jitter)
    default:
      throw new Error(`unsupported feed format: ${kind || 'unknown'}`)
  }
}

// --- RSS 2.0 ---------------------------------------------------------------

function parseRss(parsed: unknown, feedUrl: string, now: number, jitter: () => number): ParsedFeed {
  const feed = rec(parsed)
  const siteUrl = resolveUrl(feedUrl, str(feed.link)) || null
  const feedTitle = str(feed.title)

  const rawItems = arr(feed.items)
  const identities: RssItemIdentity[] = []
  const meta: Array<{ item: Rec; dc: Rec; rawUrl: string; url: string; hashContent: string; title: string }> = []

  for (const raw of rawItems) {
    const item = rec(raw)
    const dc = rec(item.dc)
    const itunes = rec(item.itunes)
    const googleplay = rec(item.googleplay)
    const contentEncoded = str(rec(item.content).encoded)

    const guid = guidText(item.guid)
    const rawUrl = [
      str(rec(item.feedburner).origLink),
      str(item.link),
      firstAlternateLink(item.links),
    ].find((u) => u !== '') ?? ''
    const resolved = resolveUrl(siteUrl, rawUrl)
    const enclosureUrl = arr(item.enclosures).map((e) => str(rec(e).url)).find((u) => u !== '') ?? ''
    const url = resolved || siteUrl || resolveUrl(siteUrl, enclosureUrl)

    // MF's content selection for identity: dc:content → description →
    // googleplay:description → itunes:summary → itunes:subtitle. feedsmith
    // exposes no dc:content, so that first term is inert; MF only reads it on
    // feeds using the non-standard element.
    const hashContent = [
      textOf(dc.content),
      str(item.description),
      str(googleplay.description),
      str(itunes.summary),
      str(itunes.subtitle),
    ].find((v) => v !== '') ?? ''

    // MF's title chain: dc:title → title (trimmed, double-unescaped) →
    // truncated content → entry URL.
    let title = htmlUnescape(htmlUnescape([first(dc.titles), str(item.title)].find((v) => v !== '') ?? '').trim())
    if (title === '') title = truncateHtmlText(hashContent, 100)
    if (title === '') title = url

    identities.push({ guid, rawUrl, url, title, content: hashContent })
    meta.push({ item, dc, rawUrl, url, hashContent, title })
  }

  const hashes = rssEntryHashes(identities)
  const items: ParsedItem[] = meta.map((m, i) => {
    const itunes = rec(m.item.itunes)
    const googleplay = rec(m.item.googleplay)
    // NB's content selection for STORAGE: prefer text/html, longest wins.
    const content = chooseContent({
      contentItems: [
        str(rec(m.item.content).encoded),
        textOf(m.dc.content),
        str(m.item.description),
        str(googleplay.description),
      ].map((value) => ({ type: value.includes('<') ? 'text/html' : 'text/plain', value })),
      summary: str(m.item.description),
      subtitle: str(itunes.subtitle),
    })
    const comments = str(m.item.comments)
    return {
      hash: hashes[i]!,
      title: m.title,
      url: m.url === '' ? null : m.url,
      // MF's findEntryAuthor chain, then its findFeedAuthor fallback.
      author:
        [
          str(rec(m.item.googleplay).author),
          str(rec(m.item.itunes).author),
          first(m.dc.creators),
          arr(m.item.authors).map(personName).find((v) => v !== '') ?? '',
          str(rec(feed.itunes).author),
          str(rec(feed.googleplay).author),
          personName(rec(feed.itunes).owner),
          personName(feed.managingEditor),
          str(feed.webMaster ?? feed.webmaster),
        ].find((v) => v !== '') ?? null,
      content,
      publishedAt: clampStoryDate(dateOf(m.item.pubDate ?? (first(m.dc.dates) || undefined)), now, jitter),
      tags: arr(m.item.categories).map((c) => (typeof c === 'string' ? c : str(rec(c).name))).filter((t) => t !== ''),
    }
  })

  return { title: feedTitle, siteUrl, iconUrl: resolveIcon(feed, siteUrl, feedUrl), items: capEntries(items) }
}

/** Feed-declared icon, resolved absolute. */
function resolveIcon(feed: Rec, siteUrl: string | null, feedUrl: string): string | null {
  const candidates = [
    str(rec(feed.image).url),
    str(feed.logo),
    textOf(feed.logo),
    str(feed.icon),
    textOf(feed.icon),
    str(feed.favicon),
  ]
  const raw = candidates.find((c) => c !== '')
  if (!raw) return null
  const resolved = resolveUrl(siteUrl ?? feedUrl, raw)
  return /^https?:\/\//i.test(resolved) ? resolved : null
}

// --- Atom 0.3 / 1.0 --------------------------------------------------------

function parseAtom(parsed: unknown, feedUrl: string, now: number, jitter: () => number): ParsedFeed {
  const feed = rec(parsed)
  const siteUrl = firstAlternateLink(feed.links) || str(feed.link) || ''

  const items: ParsedItem[] = arr(feed.entries ?? feed.items).map((raw) => {
    const entry = rec(raw)
    const id = str(entry.id)
    const originalLink = firstAlternateLink(entry.links)
    const url = resolveUrl(siteUrl || feedUrl, originalLink)
    const content = chooseContent({
      contentItems: [{ type: textOf(entry.content).includes('<') ? 'text/html' : 'text/plain', value: textOf(entry.content) }],
      summary: textOf(entry.summary),
    })
    const author = htmlUnescape(arr(entry.authors).map((a) => str(rec(a).name)).find((v) => v !== '') ?? '') || null
    return {
      hash: atomEntryHash({ id, originalLink }),
      // Atom `type="html"` titles carry HTML, and this feed ships it inside
      // CDATA: the XML layer decodes nothing in CDATA, so `&#8217;` arrives as
      // literal text. Titles are rendered as text, so decode it here. Miniflux
      // does the same for CDATA titles (atom10Text.title).
      title: htmlUnescape(textOf(entry.title)),
      url: url === '' ? null : url,
      author,
      content,
      publishedAt: clampStoryDate(dateOf(entry.published ?? entry.updated), now, jitter),
      tags: arr(entry.categories).map((c) => (typeof c === 'string' ? c : str(rec(c).name))).filter((t) => t !== ''),
    }
  })

  return { title: htmlUnescape(textOf(feed.title)), siteUrl: siteUrl || null, iconUrl: resolveIcon(feed, siteUrl || null, feedUrl), items: capEntries(items) }
}

// --- RDF / RSS 1.0 ---------------------------------------------------------

function parseRdf(parsed: unknown, feedUrl: string, now: number, jitter: () => number): ParsedFeed {
  const feed = rec(parsed)
  const siteUrl = resolveUrl(feedUrl, str(feed.link)) || null

  const items: ParsedItem[] = arr(feed.items ?? feed.entries).map((raw) => {
    const item = rec(raw)
    const dc = rec(item.dc)
    const link = resolveUrl(siteUrl, str(item.link))
    const title = htmlUnescape((str(item.title) || first(dc.titles)).trim())
    const description = str(item.description)
    return {
      hash: rdfEntryHash({ link: str(item.link), title, description }),
      title: title === '' ? link : title,
      url: link === '' ? null : link,
      // MF's RDF chain: item dc:creator → channel dc:creator.
      author: [first(dc.creators), first(rec(feed.dc).creators)].find((v) => v !== '') ?? null,
      content: chooseContent({
        contentItems: [
          { type: textOf(item.content).includes('<') ? 'text/html' : 'text/plain', value: textOf(item.content) },
        ],
        summary: description,
      }),
      publishedAt: clampStoryDate(dateOf(first(dc.dates) || undefined), now, jitter),
      tags: [],
    }
  })

  return { title: str(feed.title), siteUrl, iconUrl: resolveIcon(feed, siteUrl, feedUrl), items: capEntries(items) }
}

// --- JSON Feed -------------------------------------------------------------

function parseJson(parsed: unknown, feedUrl: string, now: number, jitter: () => number): ParsedFeed {
  const feed = rec(parsed)
  const siteUrl = resolveUrl(feedUrl, str(feed.home_page_url ?? feed.url)) || null

  const items: ParsedItem[] = arr(feed.items).map((raw) => {
    const item = rec(raw)
    const contentHTML = str(item.content_html)
    const contentText = str(item.content_text)
    const summary = str(item.summary)
    const url = resolveUrl(siteUrl, str(item.url))
    return {
      hash: jsonEntryHash({
        id: str(item.id),
        url: str(item.url),
        externalUrl: str(item.external_url),
        contentText,
        contentHTML,
        summary,
      }),
      title: str(item.title),
      url: url === '' ? null : url,
      author: arr(item.authors).map((a) => str(rec(a).name)).find((v) => v !== '') ?? null,
      content: chooseContent({
        contentItems: [
          { type: 'text/html', value: contentHTML },
          { type: 'text/plain', value: contentText },
        ],
        summary,
      }),
      publishedAt: clampStoryDate(dateOf(item.date_published ?? item.date_modified), now, jitter),
      tags: arr(item.tags).map(str).filter((t) => t !== ''),
    }
  })

  return { title: str(feed.title), siteUrl, iconUrl: resolveIcon(feed, siteUrl, feedUrl), items: capEntries(items) }
}
