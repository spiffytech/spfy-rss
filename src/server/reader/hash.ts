/**
 * Entry identity hashes: a faithful TypeScript port of Miniflux's recipe.
 *
 * Source: miniflux.app/v2/internal/reader/{rss,atom,rdf,json}/adapter.go and
 * internal/crypto/crypto.go (SHA256 = lowercase hex of SHA-256).
 * SPDX-FileCopyrightText: The Miniflux Authors
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0; see NOTICE at repo root.
 *
 * Used for exactly two things: the `UNIQUE(feed_id, hash)` dedup at insert,
 * and keeping deleted hashes out (soft-deleted rows carry the hash). Hashes
 * imported from Miniflux stay valid because this recipe is byte-identical —
 * pinned by vectors lifted from Miniflux's own test suite in
 * test/hash.test.ts.
 */

const sha256hex = (value: string): string =>
  new Bun.CryptoHasher('sha256').update(value).digest('hex')

export type RssItemIdentity = {
  /** Raw `<guid>` data. */
  guid: string
  /** The item URL as found (feedburner:origLink, link, or atom-style link) —
   * used for the no-guid fallback, before any resolution/fallback. */
  rawUrl: string
  /** Final entry URL: resolved against the site URL, falling back to the
   * site URL and then the first enclosure URL. Used for guid collisions. */
  url: string
  /** Final title (after MF's fallback chain). */
  title: string
  /** Final content. */
  content: string
}

/**
 * RSS 2.0 identity, computed across the whole feed (duplicate GUIDs in one
 * feed are disambiguated by occurrence: first stays `SHA256(guid)` so existing
 * stored entries keep matching; later ones use `guid|url` then `guid|index`).
 */
export function rssEntryHashes(items: RssItemIdentity[]): string[] {
  const seen = new Map<string, number>()
  return items.map((item) => {
    if (item.guid !== '') {
      const n = seen.get(item.guid) ?? 0
      seen.set(item.guid, n + 1)
      if (n === 0) return sha256hex(item.guid)
      if (item.url !== '') return sha256hex(`${item.guid}|${item.url}`)
      return sha256hex(`${item.guid}|${n}`)
    }
    if (item.rawUrl !== '') return sha256hex(item.rawUrl)
    return sha256hex(item.title + item.content)
  })
}

/** Atom 0.3/1.0: first non-empty of (id, alternate link); empty stays empty. */
export function atomEntryHash(item: { id: string; originalLink: string }): string {
  for (const value of [item.id, item.originalLink]) {
    if (value !== '') return sha256hex(value)
  }
  return ''
}

/** RDF/RSS 1.0: link, else title + description (hashed even when empty). */
export function rdfEntryHash(item: { link: string; title: string; description: string }): string {
  return sha256hex(item.link !== '' ? item.link : item.title + item.description)
}

/**
 * JSON Feed: first non-empty of (id, url, external_url,
 * content_text + content_html + summary), each candidate space-trimmed;
 * empty stays empty.
 */
export function jsonEntryHash(item: {
  id: string
  url: string
  externalUrl: string
  contentText: string
  contentHTML: string
  summary: string
}): string {
  for (const value of [
    item.id,
    item.url,
    item.externalUrl,
    item.contentText + item.contentHTML + item.summary,
  ]) {
    const trimmed = value.trim()
    if (trimmed !== '') return sha256hex(trimmed)
  }
  return ''
}
