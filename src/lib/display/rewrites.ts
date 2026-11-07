/**
 * Miniflux's predefined content rewrite rules (Apache-2.0, see NOTICE), ported
 * as display-time transforms. The rule is selected by the domain of the ENTRY's
 * URL, exactly as Miniflux does (`getPredefinedRewriteRules(entry.URL)`), so a
 * comic feed's entries get the treatment while the same image on another site
 * does not.
 *
 * Only `add_image_title` is ported — it is the rule every comic feed below
 * uses, and what makes xkcd's alt text visible. Miniflux pairs three of these
 * domains with further functions that are NOT ported here: blog.cloudflare.com
 * (`remove(...)`), oglaf.com (`replace(...)`) and qwantz.com
 * (`add_mailto_subject`).
 */
const ADD_IMAGE_TITLE_DOMAINS = new Set([
  'abstrusegoose.com',
  'amazingsuperpowers.com',
  'blog.cloudflare.com',
  'cowbirdsinlove.com',
  'drawingboardcomic.com',
  'exocomics.com',
  'explainxkcd.com',
  'happletea.com',
  'imogenquest.net',
  'lukesurl.com',
  'mercworks.net',
  'monkeyuser.com',
  'mrlovenstein.com',
  'nedroid.com',
  'oglaf.com',
  'optipess.com',
  'peebleslab.com',
  'qwantz.com',
  'sentfromthemoon.com',
  'thedoghousediaries.com',
  'treelobsters.com',
  'xkcd.com',
])

/** Does this entry's URL select Miniflux's `add_image_title` rule? */
export function usesAddImageTitle(entryUrl: string | null | undefined): boolean {
  if (!entryUrl) return false
  try {
    const host = new URL(entryUrl).hostname.toLowerCase()
    return ADD_IMAGE_TITLE_DOMAINS.has(host.replace(/^www\./, ''))
  } catch {
    return false
  }
}
