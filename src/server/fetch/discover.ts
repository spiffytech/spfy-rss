/**
 * Feed discovery for site URLs: find `<link rel="alternate">` elements that
 * advertise an RSS, Atom or JSON Feed. Runs only after the URL itself failed to
 * parse as a feed, so a real feed URL never pays for it.
 *
 * This is deliberately HTML-regex level, not a DOM pass: the server has no
 * browser parser, the pattern is small and fixed, and we only need href/rel/type
 * attributes from link tags. Anything malformed is skipped.
 */

const MAX_CANDIDATES = 5

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&lt;': '<',
  '&gt;': '>',
}

function decodeEntities(value: string): string {
  return value.replace(/&(?:amp|quot|#39|apos|lt|gt);/g, (match) => ENTITIES[match] ?? match)
}

const LINK_TAGS = /<link\b[^>]*>/gi

/** Read one attribute from a tag, quoted or bare. */
function attr(tag: string, name: string): string {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(
    tag,
  )
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : ''
}

function isFeedType(type: string): boolean {
  const value = type.toLowerCase().split(';')[0]!.trim()
  return (
    value === 'application/rss+xml' ||
    value === 'application/atom+xml' ||
    value === 'application/feed+json' ||
    value === 'application/x-rss+xml' ||
    value === 'application/x-atom+xml' ||
    value === 'text/xml'
  )
}

/**
 * Absolute, http(s), de-duplicated feed URLs advertised by an HTML document,
 * in document order. Relative hrefs resolve against the page that carried them.
 */
export function discoverAlternateFeeds(html: string, pageUrl: string): string[] {
  const out: string[] = []
  for (const tag of html.match(LINK_TAGS) ?? []) {
    const rel = attr(tag, 'rel').toLowerCase().split(/\s+/)
    if (!rel.includes('alternate')) continue
    if (!isFeedType(attr(tag, 'type'))) continue
    const href = decodeEntities(attr(tag, 'href')).trim()
    if (href === '') continue
    try {
      const url = new URL(href, pageUrl)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
      const value = url.toString()
      if (!out.includes(value)) out.push(value)
    } catch {
      // unparseable href: skip it
    }
  }
  return out.slice(0, MAX_CANDIDATES)
}
