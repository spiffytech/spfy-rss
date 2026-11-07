/**
 * Reading-time estimate: faithful port of Miniflux's algorithm.
 *
 * Source: miniflux.app/v2/internal/reader/readingtime/readingtime.go
 * SPDX-FileCopyrightText: The Miniflux Authors
 * SPDX-License-Identifier: Apache-2.0
 * See NOTICE at repo root; full text in LICENSES/Apache-2.0.txt.
 *
 * Strip tags → if CJK letters dominate the first 100 letters, minutes =
 * ceil(runes / 500); else ceil(words / 200). Shown on entry cards only when
 * >= READING_TIME_DISPLAY_MIN.
 */
import { htmlUnescape } from '../fetch/quirks'

export const DEFAULT_READING_SPEED = 200 // words per minute
export const CJK_READING_SPEED = 500 // characters per minute

const CJK_RANGES: Array<[number, number]> = [
  [0x3040, 0x30ff], // Hiragana + Katakana
  [0x3400, 0x4dbf], // CJK Extension A
  [0x4e00, 0x9fff], // Han
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xac00, 0xd7af], // Hangul
  [0x3130, 0x318f], // Hangul Compatibility Jamo
  [0x31f0, 0x31ff], // Katakana Phonetic Extensions
  [0x3105, 0x312f], // Bopomofo
  [0xa000, 0xa4cf], // Yi
]

function isCjkLetter(code: number): boolean {
  return CJK_RANGES.some(([lo, hi]) => code >= lo && code <= hi)
}

function isCjkDominated(text: string, limit: number): boolean {
  let letters = 0
  let cjk = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    // Letters only — numbers and punctuation make detection unreliable.
    if (!/\p{L}/u.test(ch)) continue
    letters++
    if (letters === limit) break
    if (isCjkLetter(code)) cjk++
  }
  return cjk > letters / 2
}

export function estimateReadingTime(content: string): number {
  const text = htmlUnescape(content.replace(/<[^>]*>/g, ' ')).trim()
  if (text === '') return 0
  if (isCjkDominated(text, 100)) {
    const runes = [...text].length
    return Math.ceil(runes / CJK_READING_SPEED)
  }
  const words = text.split(/\s+/).filter(Boolean).length
  return Math.ceil(words / DEFAULT_READING_SPEED)
}
