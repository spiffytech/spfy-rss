import { describe, expect, test } from 'bun:test'

import {
  assumeUtf8Charset,
  capEntries,
  chooseContent,
  clampStoryDate,
  decodeBody,
  preprocessFeedEncoding,
} from '../src/server/fetch/quirks'
import { epochMs } from '../src/shared/ids'

const NOW = 1_750_000_000_000

describe('NewsBlur quirk layer', () => {
  test('mojibake repair: entities-unescape then latin1→utf8 (NB vector)', () => {
    expect(preprocessFeedEncoding('Apple&acirc;&#128;&#153;s')).toBe('Apple\u2019s')
    // ASCII-adjacent entities ride along intact
    expect(preprocessFeedEncoding('<t>caf&amp;&acirc;&#128;&#153;</t>')).toBe('<t>caf&\u2019</t>')
    // non-ASCII latin-1 survivors decode lossy (Python errors='replace' parity)
    expect(preprocessFeedEncoding('<t>caf&copy;&acirc;&#128;&#153;</t>')).toBe(
      '<t>caf\ufffd\u2019</t>',
    )
  })

  test('mojibake repair leaves clean text and out-of-latin1 docs alone', () => {
    expect(preprocessFeedEncoding('<rss>clean text &amp; entities</rss>')).toBe(
      '<rss>clean text &amp; entities</rss>',
    )
    // U+4E2D cannot round-trip through latin1 — Python raises, NB returns the original
    expect(preprocessFeedEncoding('Apple&acirc;&#128;&#153;s \u4e2d')).toBe(
      'Apple&acirc;&#128;&#153;s \u4e2d',
    )
  })

  test('charset fallback: missing charset means UTF-8, not Windows-1252', () => {
    expect(assumeUtf8Charset('text/xml')).toBe('text/xml; charset=utf-8')
    expect(assumeUtf8Charset('text/xml; charset=ISO-8859-1')).toBe('text/xml; charset=ISO-8859-1')
    expect(assumeUtf8Charset(null)).toBe('utf-8')
  })

  test('decodeBody honors the charset and stays lossy', () => {
    const utf8 = new TextEncoder().encode('café')
    expect(decodeBody(utf8, 'text/xml')).toBe('café')
    expect(decodeBody(utf8, 'text/xml; charset=iso-8859-1')).not.toBe('café') // misread per header
  })

  test('date clamping: missing → now+jitter, pre-2000 → now, future → now+jitter', () => {
    const jitter = () => 30
    expect(clampStoryDate(null, NOW, jitter)).toBe(epochMs(NOW + 30_000))
    expect(clampStoryDate(new Date(Date.UTC(1999, 5, 1)), NOW, jitter)).toBe(epochMs(NOW))
    expect(clampStoryDate(new Date(NOW + 86_400_000), NOW, jitter)).toBe(epochMs(NOW + 30_000))
    expect(clampStoryDate(new Date(NOW - 1000), NOW, jitter)).toBe(epochMs(NOW - 1000))
  })

  test('entry cap: newest 100 survive', () => {
    const items = Array.from({ length: 150 }, (_, i) => ({ publishedAt: epochMs(1_000_000 + i) }))
    const capped = capEntries(items)
    expect(capped).toHaveLength(100)
    expect(capped[0]!.publishedAt).toBe(epochMs(1_000_149))
  })

  test('content selection: longest text/html wins, then longest any, summary, subtitle', () => {
    expect(
      chooseContent({
        contentItems: [
          { type: 'text/html', value: '<p>real article body</p>' },
          {
            type: 'text/plain',
            value: 'a much much much longer plain caption that would win if types were ignored',
          },
        ],
        summary: 'short',
      }),
    ).toBe('<p>real article body</p>')
    expect(chooseContent({ contentItems: [{ value: 'aaa' }, { value: 'bb' }], summary: 'c' })).toBe(
      'aaa',
    )
    expect(chooseContent({ contentItems: [], summary: 'summary text' })).toBe('summary text')
    expect(chooseContent({ contentItems: [], summary: '', subtitle: '  subtitle  ' })).toBe(
      'subtitle',
    )
  })
})
