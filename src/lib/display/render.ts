/**
 * Display pipeline (client-only): raw feed HTML → transformed string → safe
 * sink. The Sanitizer API is DOM-time only, so this module runs in the
 * browser; entry content is NEVER server-rendered through `{@html}` (repo
 * AGENTS.md rule).
 *
 * transformEntryContent(): inert parse (`Document.parseHTMLUnsafe`, the tree
 * is never inserted) → DOM walk (YouTube → <lite-youtube>, relative URLs
 * resolved against the feed base, `<base>` dropped) → serialized string.
 *
 * sinkEntryContent(): `Element.setHTML()` with the shared policy; on Safari
 * (Sanitizer API not shipped) DOMPurify compiled from the SAME policy table.
 */
import DOMPurify from 'dompurify'

import { POLICY, safeUrlProtocol, toDomPurifyConfig, toSanitizerConfig } from './policy'
import { usesAddImageTitle } from './rewrites'
import { parseYouTubeUrl } from './youtube'

const URL_ATTRS: Array<[string, string]> = [
  ['a', 'href'],
  ['img', 'src'],
  ['video', 'src'],
  ['video', 'poster'],
  ['audio', 'src'],
  ['source', 'srcset'],
  ['blockquote', 'cite'],
]

function resolveOrDrop(element: Element, attr: string, feedBaseUrl: string): void {
  const raw = element.getAttribute(attr)
  if (raw === null) return
  const trimmed = raw.trim()
  if (trimmed === '') {
    element.removeAttribute(attr)
    return
  }
  if (attr === 'srcset') {
    // Keep the candidate list, resolve each URL; drop unsafe candidates.
    const resolved = trimmed
      .split(',')
      .map((candidate) => {
        const parts = candidate.trim().split(/\s+/)
        const url = resolveUrl(parts[0] ?? '', feedBaseUrl)
        return safeUrlProtocol(url) ? [url, ...parts.slice(1)].join(' ') : null
      })
      .filter((c): c is string => c !== null)
    if (resolved.length === 0) element.removeAttribute(attr)
    else element.setAttribute(attr, resolved.join(', '))
    return
  }
  // Resolve first (relative URLs are only meaningful against the feed base),
  // THEN gate the absolute result's protocol.
  const resolved = resolveUrl(trimmed, feedBaseUrl)
  if (!safeUrlProtocol(resolved)) {
    element.removeAttribute(attr)
    return
  }
  element.setAttribute(attr, resolved)
}

function resolveUrl(raw: string, feedBaseUrl: string): string {
  if (raw.startsWith('#')) return raw
  try {
    return new URL(raw, feedBaseUrl).toString()
  } catch {
    return raw
  }
}

/** Miniflux's add_image_title replacement markup: the image (src + alt only,
 *  the title is dropped) inside a figure, its title as the caption text. */
function wrapImageTitle(img: Element, src: string, title: string): Element {
  const doc = img.ownerDocument
  const figure = doc.createElement('figure')
  const image = doc.createElement('img')
  image.setAttribute('src', src)
  image.setAttribute('alt', img.getAttribute('alt') ?? '')
  const caption = doc.createElement('figcaption')
  const paragraph = doc.createElement('p')
  paragraph.textContent = title
  caption.append(paragraph)
  figure.append(image, caption)
  return figure
}

function walk(node: Element, feedBaseUrl: string, addImageTitle: boolean): Element | null {
  const tag = node.tagName.toLowerCase()

  // <base> in entry markup re-targets every relative URL — drop it outright.
  if (tag === 'base') return null

  // Miniflux's add_image_title rule (comic feeds): the image's title IS the
  // joke — xkcd's alt text — so it becomes visible in a figcaption and the
  // tooltip is dropped. The new img carries no title, so this cannot re-fire.
  if (addImageTitle && tag === 'img') {
    const src = node.getAttribute('src')
    const title = node.getAttribute('title')
    if (src !== null && title !== null && title.trim() !== '') {
      return walk(wrapImageTitle(node, src, title), feedBaseUrl, addImageTitle)
    }
  }

  // YouTube embeds → lite-youtube custom element (allowed by the policy).
  if (tag === 'iframe') {
    const src = node.getAttribute('src') ?? ''
    const youtube = parseYouTubeUrl(src)
    if (!youtube) return null // only lite-youtube embeds survive (policy)
    const lite = node.ownerDocument.createElement('lite-youtube')
    lite.setAttribute('videoid', youtube.videoId)
    if (youtube.params !== '') lite.setAttribute('params', youtube.params)
    const title = node.getAttribute('title')
    if (title) lite.setAttribute('title', title)
    return lite
  }

  const policy = POLICY[tag]
  if (policy) {
    // Drop attributes outside the policy for this element.
    for (const attr of [...node.attributes]) {
      const allowed =
        (policy.urlAttrs ?? []).includes(attr.name) || policy.attrs.includes(attr.name)
      if (!allowed && !['class', 'title', 'lang', 'dir', 'id'].includes(attr.name))
        node.removeAttribute(attr.name)
    }
    for (const [, attr] of URL_ATTRS) {
      if (node.hasAttribute(attr)) resolveOrDrop(node, attr, feedBaseUrl)
    }
    // Non-http(s) link targets never survive.
    if (tag === 'a' && node.hasAttribute('href')) {
      node.setAttribute('rel', 'noopener noreferrer')
      node.setAttribute('target', '_blank')
    }
  }

  for (const child of [...node.children]) {
    const replacement = walk(child, feedBaseUrl, addImageTitle)
    if (replacement === null) child.remove()
    else if (replacement !== child) child.replaceWith(replacement)
  }
  return node
}

/** Raw stored HTML → transformed display HTML (still untrusted until sunk).
 *  `entryUrl` (the entry's own URL, not the feed's) selects Miniflux's
 *  per-domain rewrite rules. */
export function transformEntryContent(
  rawHtml: string,
  feedBaseUrl: string,
  entryUrl?: string | null,
): string {
  const doc = Document.parseHTMLUnsafe(rawHtml)
  const body = doc.body
  walk(body, feedBaseUrl, usesAddImageTitle(entryUrl))
  return body.innerHTML
}

/** Sink transformed HTML into an element through a safe sanitizer. */
/** loading="lazy" on imgs/iframes + an explicit aspect-ratio on sized iframes
 *  (port of the old lazyHtml). Runs AFTER the sink so it needs no sanitizer
 *  allowance for `loading`/`style` — DOM property writes only. An iframe has
 *  no intrinsic ratio, so max-width:100% alone distorts it; deriving the ratio
 *  from width/height makes the height scale with the width. */
export function applyEmbedHints(root: Element): void {
  for (const el of root.querySelectorAll('img, iframe')) {
    if (!el.hasAttribute('loading')) el.setAttribute('loading', 'lazy')
  }
  for (const el of Array.from(root.querySelectorAll('iframe'))) {
    const w = Number(el.getAttribute('width'))
    const h = Number(el.getAttribute('height'))
    if (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) {
      ;(el as HTMLElement).style.aspectRatio = `${w} / ${h}`
    }
  }
}

export function sinkEntryContent(target: Element, transformedHtml: string): void {
  // The Sanitizer API config shape is still settling across engines; the
  // policy adapter passes its table through and falls back to setHTML's safe
  // DEFAULT sanitizer if the engine rejects the config (day-one smoke test
  // reconciles this — plan Phase 4).
  const SanitizerCtor = (globalThis as unknown as { Sanitizer?: new (config?: unknown) => unknown })
    .Sanitizer
  const setHTML = (target as unknown as { setHTML?: (html: string, opts?: unknown) => void })
    .setHTML
  if (SanitizerCtor && typeof setHTML === 'function') {
    const config = toSanitizerConfig()
    try {
      setHTML.call(target, transformedHtml, {
        sanitizer: new SanitizerCtor(config),
      })
      applyEmbedHints(target)
      return
    } catch (error) {
      // Engine rejected the policy config: fall back to setHTML's safe DEFAULT
      // sanitizer (less tailored) and leave markers for the smoke suite.
      target.setAttribute('data-sink-fallback', '')
      target.setAttribute('data-sink-error', String(error))
      setHTML.call(target, transformedHtml)
      applyEmbedHints(target)
      return
    }
  }
  const config = toDomPurifyConfig()
  target.innerHTML = DOMPurify.sanitize(transformedHtml, {
    ALLOWED_TAGS: config.ALLOWED_TAGS,
    ALLOWED_ATTR: config.ALLOWED_ATTR,
    CUSTOM_ELEMENT_HANDLING: config.CUSTOM_ELEMENT_HANDLING,
    ALLOWED_URI_REGEXP: config.ALLOWED_URI_REGEXP,
  }) as unknown as string
  applyEmbedHints(target)
}
