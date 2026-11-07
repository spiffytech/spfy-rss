/**
 * The ONE display policy for untrusted feed HTML, consumed by both safe
 * sinks: `Element.setHTML()` (Chrome/Firefox) and DOMPurify (Safari). Both
 * adapters read this table so the two engines can't drift apart; the fixture
 * suite asserts they agree.
 *
 * Entry content is untrusted: it is inserted client-side only, never via
 * `{@html}` on the server (see the repo AGENTS.md rule).
 */

export type ElementPolicy = {
  /** Allowed attributes (global ones are added automatically). */
  attrs: string[]
  /** Which of those carry URLs (protocol-checked against safeUrlProtocol). */
  urlAttrs?: string[]
}

/** Attributes allowed on every allowed element. */
export const GLOBAL_ATTRS = ['class', 'title', 'lang', 'dir', 'id'] as const

/** URL schemes entry markup may keep. Everything else is stripped. */
export function safeUrlProtocol(url: string): boolean {
  const value = url.trim().toLowerCase()
  return (
    value === '' ||
    value.startsWith('https://') ||
    value.startsWith('http://') ||
    value.startsWith('mailto:') ||
    value.startsWith('#')
  )
}

export const POLICY: Record<string, ElementPolicy> = {
  p: { attrs: [] },
  br: { attrs: [] },
  hr: { attrs: [] },
  div: { attrs: [] },
  span: { attrs: [] },
  blockquote: { attrs: ['cite'], urlAttrs: ['cite'] },
  pre: { attrs: [] },
  code: { attrs: [] },
  kbd: { attrs: [] },
  samp: { attrs: [] },
  var: { attrs: [] },
  strong: { attrs: [] },
  b: { attrs: [] },
  em: { attrs: [] },
  i: { attrs: [] },
  u: { attrs: [] },
  s: { attrs: [] },
  del: { attrs: [] },
  ins: { attrs: [] },
  mark: { attrs: [] },
  small: { attrs: [] },
  sub: { attrs: [] },
  sup: { attrs: [] },
  abbr: { attrs: [] },
  cite: { attrs: [] },
  q: { attrs: [] },
  a: { attrs: ['href', 'rel', 'target'], urlAttrs: ['href'] },
  ul: { attrs: [] },
  ol: { attrs: ['start', 'reversed', 'type'] },
  li: { attrs: ['value'] },
  dl: { attrs: [] },
  dt: { attrs: [] },
  dd: { attrs: [] },
  table: { attrs: ['summary'] },
  caption: { attrs: [] },
  colgroup: { attrs: ['span'] },
  col: { attrs: ['span'] },
  thead: { attrs: [] },
  tbody: { attrs: [] },
  tfoot: { attrs: [] },
  tr: { attrs: [] },
  th: { attrs: ['colspan', 'rowspan', 'scope', 'headers'] },
  td: { attrs: ['colspan', 'rowspan', 'headers'] },
  img: { attrs: ['src', 'alt', 'width', 'height', 'loading'], urlAttrs: ['src'] },
  picture: { attrs: [] },
  source: { attrs: ['srcset', 'media', 'type'], urlAttrs: ['srcset'] },
  figure: { attrs: [] },
  figcaption: { attrs: [] },
  video: { attrs: ['src', 'controls', 'width', 'height', 'poster'], urlAttrs: ['src', 'poster'] },
  audio: { attrs: ['src', 'controls'], urlAttrs: ['src'] },
  details: { attrs: ['open'] },
  summary: { attrs: [] },
  h1: { attrs: [] },
  h2: { attrs: [] },
  h3: { attrs: [] },
  h4: { attrs: [] },
  h5: { attrs: [] },
  h6: { attrs: [] },
  // Ported custom element (lite-youtube-embed, Apache-2.0, see NOTICE).
  'lite-youtube': {
    attrs: ['videoid', 'title', 'playlabel', 'params', 'poster'],
    urlAttrs: ['poster'],
  },
}

const allowedElements = Object.keys(POLICY)

export function allowedAttributesFor(name: string): string[] {
  // dedupe: e.g. lite-youtube lists `title`, which is also global — the
  // Sanitizer constructor rejects configs with duplicate attribute names.
  return [...new Set([...GLOBAL_ATTRS, ...(POLICY[name]?.attrs ?? [])])]
}

/** Sanitizer API shape (Element.setHTML) — verified against Chrome's engine:
 * `elements` takes `{name, attributes}` entries (a Record for `attributes`
 * throws: it must be iterable). */
export function toSanitizerConfig(): {
  elements: Array<{ name: string; attributes: string[] }>
  allowCustomElements: boolean
} {
  return {
    elements: allowedElements.map((name) => ({ name, attributes: allowedAttributesFor(name) })),
    // Probe-verified in Chrome: an element listed here survives even with
    // `allowCustomElements: false` (the flag governs UNLISTED custom
    // elements) — so false is the tight setting, true buys nothing.
    allowCustomElements: false,
  }
}

/** DOMPurify shape compiled from the same table. */
export function toDomPurifyConfig(): {
  ALLOWED_TAGS: string[]
  ALLOWED_ATTR: string[]
  CUSTOM_ELEMENT_HANDLING: {
    tagNameCheck: RegExp
    attributeNameCheck: RegExp
    allowCustomizedBuiltInElements: boolean
  }
  ALLOWED_URI_REGEXP: RegExp
} {
  const attrSet = new Set<string>()
  for (const name of allowedElements)
    for (const attr of allowedAttributesFor(name)) attrSet.add(attr)
  return {
    ALLOWED_TAGS: allowedElements,
    ALLOWED_ATTR: [...attrSet],
    CUSTOM_ELEMENT_HANDLING: {
      tagNameCheck: /^lite-youtube$/,
      attributeNameCheck: /^(videoid|title|playlabel|params|poster)$/,
      allowCustomizedBuiltInElements: false,
    },
    ALLOWED_URI_REGEXP: /^(?:https?|mailto|tel):|^#|^\/\//i,
  }
}
