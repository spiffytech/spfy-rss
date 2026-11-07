import { expect, test } from 'bun:test'

import {
  GLOBAL_ATTRS,
  POLICY,
  safeUrlProtocol,
  toDomPurifyConfig,
  toSanitizerConfig,
} from '../src/lib/display/policy'
import { usesAddImageTitle } from '../src/lib/display/rewrites'
import { parseYouTubeUrl } from '../src/lib/display/youtube'

test('YouTube URL shapes all resolve to one embed', () => {
  for (const url of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://m.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube-nocookie.com/v/dQw4w9WgXcQ',
  ]) {
    expect(parseYouTubeUrl(url)?.videoId).toBe('dQw4w9WgXcQ')
  }
})

test('playback params survive, video id does not', () => {
  const embed = parseYouTubeUrl(
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&start=42&list=PL1&junk=1',
  )
  expect(embed).toEqual({ videoId: 'dQw4w9WgXcQ', params: 'start=42&list=PL1' })
  expect(parseYouTubeUrl('https://youtu.be/dQw4w9WgXcQ?t=90')?.params).toBe('t=90')
})

test('non-YouTube and garbage URLs are refused', () => {
  expect(parseYouTubeUrl('https://vimeo.com/12345')).toBeNull()
  expect(parseYouTubeUrl('https://evil.com/watch?v=dQw4w9WgXcQ')).toBeNull()
  expect(parseYouTubeUrl('not a url')).toBeNull()
  expect(parseYouTubeUrl('https://www.youtube.com/watch?v=')).toBeNull()
  expect(parseYouTubeUrl('https://www.youtube.com/watch?v=has spaces')).toBeNull()
})

test('the policy table feeds both engines consistently', () => {
  const sanitizer = toSanitizerConfig()
  const purify = toDomPurifyConfig()
  const names = sanitizer.elements.map((e) => e.name)
  expect(names).toEqual(Object.keys(POLICY))
  expect(purify.ALLOWED_TAGS).toEqual(names)
  // every sanitized attr for a policy element is present in the purify list
  for (const [name, entry] of Object.entries(POLICY)) {
    const element = sanitizer.elements.find((e) => e.name === name)!
    for (const attr of [...entry.attrs, ...GLOBAL_ATTRS]) {
      expect(purify.ALLOWED_ATTR).toContain(attr)
      expect(element.attributes).toContain(attr)
    }
  }
  // the custom element is allowlisted with exactly its attribute set
  expect(sanitizer.elements.find((e) => e.name === 'lite-youtube')!.attributes).toContain('videoid')
  expect(purify.CUSTOM_ELEMENT_HANDLING.tagNameCheck.test('lite-youtube')).toBe(true)
  expect(purify.CUSTOM_ELEMENT_HANDLING.tagNameCheck.test('lite-evil')).toBe(false)
})

test('safe URL protocol gate', () => {
  expect(safeUrlProtocol('https://example.com/')).toBe(true)
  expect(safeUrlProtocol('http://example.com/')).toBe(true)
  expect(safeUrlProtocol('mailto:a@b.example')).toBe(true)
  expect(safeUrlProtocol('#section')).toBe(true)
  expect(safeUrlProtocol('javascript:alert(1)')).toBe(false)
  expect(safeUrlProtocol('data:text/html,<script>')).toBe(false)
  expect(safeUrlProtocol('  JAVASCRIPT:alert(1)')).toBe(false)
})

test('script-capable elements are absent from the policy', () => {
  for (const banned of [
    'script',
    'style',
    'iframe',
    'object',
    'embed',
    'link',
    'meta',
    'form',
    'input',
    'svg',
    'math',
  ]) {
    expect(POLICY[banned]).toBeUndefined()
  }
})

test('add_image_title keys off the entry URL domain, as Miniflux does', () => {
  expect(usesAddImageTitle('https://xkcd.com/927/')).toBe(true)
  expect(usesAddImageTitle('https://www.xkcd.com/927/')).toBe(true) // www stripped
  expect(usesAddImageTitle('https://explainxkcd.com/wiki/index.php/927')).toBe(true)
  expect(usesAddImageTitle('https://example.com/xkcd.com/927')).toBe(false) // path, not host
  expect(usesAddImageTitle('https://notxkcd.com/927/')).toBe(false)
  expect(usesAddImageTitle(null)).toBe(false)
  expect(usesAddImageTitle('not a url')).toBe(false)
})
