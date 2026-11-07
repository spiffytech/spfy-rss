import { describe, expect, test } from 'bun:test'

import {
  atomEntryHash,
  jsonEntryHash,
  rdfEntryHash,
  rssEntryHashes,
  type RssItemIdentity,
} from '../src/server/reader/hash'

/**
 * Vectors lifted verbatim from Miniflux's test suite
 * (internal/reader/{rss,atom}/*_test.go, Apache-2.0 — see NOTICE). These pin
 * the port byte-for-byte: the import brings hash values computed by Miniflux,
 * so the first refetch must compute identical ones or entries duplicate.
 */
describe('entry hash recipe (port of Miniflux)', () => {
  const item = (over: Partial<RssItemIdentity>): RssItemIdentity => ({
    guid: '',
    rawUrl: '',
    url: '',
    title: '',
    content: '',
    ...over,
  })

  test('RSS: guid wins (MF vector: guid "1234")', () => {
    expect(rssEntryHashes([item({ guid: '1234', url: 'https://example.org/' })])).toEqual([
      '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4',
    ])
  })

  test('RSS: no guid, no url → title+content (MF vectors "Item 1"/"Item 2")', () => {
    expect(rssEntryHashes([item({ title: 'Item 1' }), item({ title: 'Item 2' })])).toEqual([
      'c5ddfeffb275254140796b8c080f372d65ebb1b0590e238b191f595d5fcd32ca',
      '0a937478f9bdbfca2de5cdeeb5ee7b09678a3330fc7cc5b05169a50d4516c9a3',
    ])
  })

  test('RSS: duplicate guid disambiguation — first stable, then guid|url (MF vectors)', () => {
    expect(
      rssEntryHashes([
        item({ guid: 'dup-guid', url: 'https://example.org/' }),
        item({ guid: 'dup-guid', url: 'https://example.org/' }),
      ]),
    ).toEqual([
      '22561495b53d916c228504600fda7c06cefc55a80395bbdf007102a6e9070d3f',
      '175d6d57a61533fb553c5d9bc3d52aa9092553a7e0ae473e3536c32c87cfa418',
    ])
  })

  test('RSS: unique guids hash as SHA256(guid) forever (MF regression vectors)', () => {
    expect(
      rssEntryHashes([
        item({ guid: 'guid-a', rawUrl: 'https://example.org/a', url: 'https://example.org/a' }),
        item({ guid: 'guid-b', rawUrl: 'https://example.org/b', url: 'https://example.org/b' }),
      ]),
    ).toEqual([
      '2b13a8de1741fb778d7e733e7a888088cb578d22e5ec6d40e0a88f82d4829cbd',
      '33ce1b8657a81c6a49590313a36325e44683f27229e96faa690f9dc7b2a75d2a',
    ])
  })

  test('RSS: colliding guids without any url fall back to the position index', () => {
    const [first, second] = rssEntryHashes([item({ guid: 'dup' }), item({ guid: 'dup' })])
    const expectedSecond = new Bun.CryptoHasher('sha256').update('dup|1').digest('hex')
    expect(first).toBe(new Bun.CryptoHasher('sha256').update('dup').digest('hex'))
    expect(second).toBe(expectedSecond)
  })

  test('RSS: no guid but a raw url → SHA256(url)', () => {
    expect(rssEntryHashes([item({ rawUrl: 'https://example.org/post' })])).toEqual([
      new Bun.CryptoHasher('sha256').update('https://example.org/post').digest('hex'),
    ])
  })

  test('Atom: id first, link fallback (MF vectors)', () => {
    expect(
      atomEntryHash({
        id: 'tag:diveintomark.org,2003:3.2397',
        originalLink: 'http://diveintomark.org/2003/12/13/atom03',
      }),
    ).toBe('b70d30334b808f32e66eb19fabb263525cecd18f205720b583e84f7f295cf728')
    expect(
      atomEntryHash({
        id: 'urn:uuid:1225c695-cfb8-4ebb-aaaa-80da344efa6a',
        originalLink: 'http://example.org/2003/12/13/atom03',
      }),
    ).toBe('3841e5cf232f5111fc5841e9eba5f4b26d95e7d7124902e0f7272729d65601a6')
    expect(atomEntryHash({ id: '', originalLink: '' })).toBe('')
  })

  test('RDF: link first, title+description fallback (hashed even when empty)', () => {
    const h = (v: string) => new Bun.CryptoHasher('sha256').update(v).digest('hex')
    expect(rdfEntryHash({ link: 'https://example.org/x', title: 'T', description: 'D' })).toBe(
      h('https://example.org/x'),
    )
    expect(rdfEntryHash({ link: '', title: 'T', description: 'D' })).toBe(h('TD'))
    expect(rdfEntryHash({ link: '', title: '', description: '' })).toBe(h(''))
  })

  test('JSON: trimmed chain id → url → external_url → content concat', () => {
    const h = (v: string) => new Bun.CryptoHasher('sha256').update(v).digest('hex')
    const base = { id: '', url: '', externalUrl: '', contentText: '', contentHTML: '', summary: '' }
    expect(jsonEntryHash({ ...base, id: '  abc  ' })).toBe(h('abc'))
    expect(jsonEntryHash({ ...base, url: 'https://x.example/' })).toBe(h('https://x.example/'))
    expect(jsonEntryHash({ ...base, externalUrl: 'https://y.example/' })).toBe(
      h('https://y.example/'),
    )
    expect(
      jsonEntryHash({ ...base, contentText: 'text', contentHTML: '<p>html</p>', summary: 'sum' }),
    ).toBe(h('text<p>html</p>sum'))
    expect(jsonEntryHash(base)).toBe('')
  })
})
