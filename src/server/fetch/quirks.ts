/**
 * Feed-fetch quirk fixes ported from NewsBlur (MIT).
 *
 * Source: NewsBlur `utils/feed_fetcher.py` (preprocess_feed_encoding, charset
 * fallback, entry cap) and `utils/story_functions.py` (extract_story_date,
 * content selection).
 * SPDX-FileCopyrightText: NewsBlur / Samuel Clay
 * SPDX-License-Identifier: MIT
 * See NOTICE at repo root; full text in LICENSES/MIT.txt.
 *
 * Superseded (NOT ported): NewsBlur's single-guid replacement and guid
 * fallback chain. Miniflux's duplicate-GUID ladder in hash.ts covers the same
 * broken feeds while staying byte-compatible with imported Miniflux hashes —
 * the two substitutions would change identity and duplicate the imported
 * corpus on first refetch.
 */
import type { EpochMs } from '../../shared/ids'
import { epochMs } from '../../shared/ids'

// --- mojibake repair (feed_fetcher.preprocess_feed_encoding) ---------------

/** Indicators of UTF-8 bytes misread as Latin-1/CP1252 then HTML-encoded. */
const MOJIBAKE_INDICATORS = [
  '&acirc;&#128;&#153;',
  '&acirc;&#128;&#147;',
  '&acirc;&#128;&#148;',
  '&acirc;&#128;&#156;',
  '&acirc;&#128;&#157;',
  '&acirc;&#128;&#152;',
  '&acirc;&#128;&#153;',
  '&acirc;&#128;&#166;',
  '&acirc;&#128;&#160;',
  '&acirc;&#128;&#176;',
  '&acirc;&#128;&#174;',
  '&acirc;&#128;&#169;',
  '&Atilde;&copy;',
  '&Atilde;&reg;',
  '&Atilde;&para;',
  '&Atilde;&sup2;',
  '&Atilde;&deg;',
  '&Aring;&frac12;',
]

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  copy: '\u00a9',
  reg: '\u00ae',
  para: '\u00b6',
  sup2: '\u00b2',
  sup3: '\u00b3',
  sup1: '\u00b9',
  deg: '\u00b0',
  frac12: '\u00bd',
  frac14: '\u00bc',
  frac34: '\u00be',
  Aring: '\u00c5',
  Atilde: '\u00c3',
  acirc: '\u00e2',
  eacute: '\u00e9',
  egrave: '\u00e8',
  agrave: '\u00e0',
  auml: '\u00e4',
  ouml: '\u00f6',
  uuml: '\u00fc',
  iuml: '\u00ef',
  ouml2: '\u00f6',
  ccedil: '\u00e7',
  ntilde: '\u00f1',
  oacute: '\u00f3',
  uacute: '\u00fa',
  iacute: '\u00ed',
  szlig: '\u00df',
  ndash: '\u2013',
  mdash: '\u2014',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  hellip: '\u2026',
  bull: '\u2022',
  middot: '\u00b7',
  laquo: '\u00ab',
  raquo: '\u00bb',
  times: '\u00d7',
  divide: '\u00f7',
  plusmn: '\u00b1',
  micro: '\u00b5',
  sect: '\u00a7',
  yen: '\u00a5',
  cent: '\u00a2',
  pound: '\u00a3',
  curren: '\u00a4',
  iquest: '\u00bf',
  iexcl: '\u00a1',
  ordf: '\u00aa',
  ordm: '\u00ba',
  not: '\u00ac',
  shy: '\u00ad',
  macr: '\u00af',
  acute: '\u00b4',
  cedil: '\u00b8',
  uml: '\u00a8',
  eth: '\u00f0',
  thorn: '\u00fe',
  ETH: '\u00d0',
  THORN: '\u00de',
  aelig: '\u00e6',
  AElig: '\u00c6',
  oslash: '\u00f8',
  Oslash: '\u00d8',
  scaron: '\u0161',
  Scaron: '\u0160',
  oelig: '\u0153',
  OElig: '\u0152',
  Yuml: '\u0178',
  fnof: '\u0192',
  circ: '\u02c6',
  tilde: '\u02dc',
}

/** HTML entity unescape (named + decimal + hex), sufficient for the repair. */
export function htmlUnescape(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    const named = NAMED_ENTITIES[body]
    return named === undefined ? whole : named
  })
}

/**
 * Reverses the "UTF-8 read as Latin-1, then HTML-encoded" corruption: unescape
 * entities, reinterpret the code points as Latin-1 bytes, decode as UTF-8.
 * Returns the input unchanged when no indicator is present, when a code point
 * exceeds the Latin-1 range (Python's encode('latin1') would raise), or when
 * the re-decode fails outright.
 */
export function preprocessFeedEncoding(rawXml: string): string {
  if (!MOJIBAKE_INDICATORS.some((indicator) => rawXml.includes(indicator))) return rawXml
  const unescaped = htmlUnescape(rawXml)
  if ([...unescaped].some((ch) => ch.codePointAt(0)! > 0xff)) return rawXml
  const bytes = new Uint8Array(unescaped.length)
  for (let i = 0; i < unescaped.length; i++) bytes[i] = unescaped.charCodeAt(i) & 0xff
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes) // errors='replace'
  }
}

// --- charset fallback (feed_fetcher) ---------------------------------------

/**
 * When the Content-Type header exists but specifies no charset, NewsBlur
 * appends UTF-8 explicitly so the parser doesn't guess Windows-1252.
 */
export function assumeUtf8Charset(contentType: string | null | undefined): string {
  if (!contentType) return 'utf-8'
  return contentType.toLowerCase().includes('charset')
    ? contentType
    : `${contentType}; charset=utf-8`
}

/** Decode bytes with the charset from the (fixed) Content-Type, lossy. */
export function decodeBody(bytes: Uint8Array, contentType: string | null | undefined): string {
  const fixed = assumeUtf8Charset(contentType)
  const charset = /charset=([^;\s]+)/i.exec(fixed)?.[1]?.replace(/^["']|["']$/g, '') ?? 'utf-8'
  let decoder: TextDecoder
  try {
    decoder = new TextDecoder(charset)
  } catch {
    decoder = new TextDecoder('utf-8')
  }
  return decoder.decode(bytes)
}

// --- date clamping (story_functions.extract_story_date) --------------------

/**
 * Missing → now + jitter(0–59s); pre-2000 → now; future → now + jitter.
 * (Jitter exists so auto-dated entries don't all collapse onto one instant.)
 */
export function clampStoryDate(
  candidate: Date | null | undefined,
  now: number,
  jitterSeconds: () => number,
): EpochMs {
  if (
    !candidate ||
    Number.isNaN(candidate.getTime()) ||
    candidate.getTime() < Date.UTC(2000, 0, 1)
  ) {
    if (!candidate || Number.isNaN(candidate.getTime()))
      return epochMs(now + jitterSeconds() * 1000)
    return epochMs(now) // present but pre-2000: clamped to now, no jitter (NB parity)
  }
  if (candidate.getTime() > now) return epochMs(now + jitterSeconds() * 1000)
  return epochMs(candidate.getTime())
}

// --- entry cap (feed_fetcher.MAX_ENTRIES_TO_PROCESS) -----------------------

export const MAX_ENTRIES_TO_PROCESS = 100

/** Over the cap: keep the newest 100 (sort by date desc, cut). */
export function capEntries<T extends { publishedAt: EpochMs }>(items: T[]): T[] {
  if (items.length <= MAX_ENTRIES_TO_PROCESS) return items
  return [...items]
    .sort((a, b) => (b.publishedAt as number) - (a.publishedAt as number))
    .slice(0, MAX_ENTRIES_TO_PROCESS)
}

// --- content selection (story_functions.pre_process_story) ----------------

export type ContentCandidate = { type?: string | undefined; value?: string | undefined }

/**
 * Prefer text/html content items, longest first (Ghost-style feeds interleave
 * media captions with the article body); fall back to the longest of any
 * content; then the summary; then the subtitle. NB strips whitespace here —
 * raw feed HTML is otherwise preserved unmodified.
 */
export function chooseContent(candidates: {
  contentItems?: ContentCandidate[] | undefined
  summary?: string | undefined
  subtitle?: string | undefined
}): string {
  const items = candidates.contentItems ?? []
  const htmlItems = items.filter((c) => c.type === 'text/html')
  const pool = htmlItems.length > 0 ? htmlItems : items
  let content = ''
  for (const candidate of pool) {
    const value = candidate.value ?? ''
    if (value.length > content.length) content = value
  }
  const summary = candidates.summary ?? ''
  const chosen = content.length > summary.length ? content : summary
  return (chosen === '' ? (candidates.subtitle ?? '') : chosen).trim()
}
