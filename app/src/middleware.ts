import type { StartMiddleware } from '@solidjs/vite-plugin'

import { handleApiRoute } from './api-routes'
import { readSession, SESSION_COOKIE, type SessionUser } from './server/auth'
import { collectingCookieJar, type CookieJar } from './server/cookies'

declare module '@solidjs/web' {
  interface RequestEventLocals {
    user: SessionUser | null
    cookies: CookieJar
  }
}

/** The only pages an anonymous visitor may see. */
const LOGIN_PATH = '/login'
const SIGNUP_PATH = '/signup'
const PUBLIC_PATHS = new Set([LOGIN_PATH, SIGNUP_PATH])

/** Paths the handler must answer itself, whatever the visitor's state. */
const isServerFunction = (path: string) => path === '/_server' || path.startsWith('/_server/')

/**
 * Old URL shapes, kept because they are in the wild: a bookmarked feed URL, a
 * search box that submits GET, and anything else — the old app bounced unknown
 * paths to the reader root. Only document navigations are redirected, so an
 * asset or RPC request can never be turned into a page.
 */
const legacyRedirect = (url: URL, isDocument: boolean): string | null => {
  if (!isDocument) return null
  const feed = url.pathname.match(/^\/feed\/([^/]+)$/)
  if (feed) return `/?feed=${encodeURIComponent(feed[1]!)}`
  if (url.pathname === '/search') {
    const q = url.searchParams.get('q') ?? ''
    return q === '' ? '/' : `/?search=${encodeURIComponent(q)}`
  }
  if (url.pathname !== '/' && url.pathname !== LOGIN_PATH && url.pathname !== SIGNUP_PATH) return '/'
  return null
}

export default (async (event, next) => {
  const request = event.request
  const url = new URL(request.url)

  const { jar, setCookies } = collectingCookieJar(request.headers.get('cookie'))
  event.locals.cookies = jar
  event.locals.user = readSession(jar.get(SESSION_COOKIE))

  // Public URL endpoints (WebSub callbacks, health, feed icons) are plain
  // handlers: they are not RPC and must not carry the server-function protocol
  // or its same-origin CSRF check.
  const apiResponse = await handleApiRoute(request, { user: event.locals.user })
  if (apiResponse) {
    for (const cookie of setCookies) apiResponse.headers.append('set-cookie', cookie)
    return apiResponse
  }

  // One complete document per render. Streaming would paint fallbacks first,
  // and this app renders its chrome (toolbar, sidebar) outside any boundary —
  // there is nothing to swap in, only something to flash.
  event.renderMode = 'async'

  const redirect =
    legacyRedirect(url, request.headers.get('accept')?.includes('text/html') ?? false) ??
    // The auth gate. `/_server` is never redirected: the server-function
    // runtime answers each call and every export gates itself.
    (!event.locals.user && !PUBLIC_PATHS.has(url.pathname) && !isServerFunction(url.pathname)
      ? LOGIN_PATH
      : null) ??
    (event.locals.user && PUBLIC_PATHS.has(url.pathname) ? '/' : null)

  if (redirect) {
    const response = new Response(null, { status: 302, headers: { location: redirect } })
    for (const cookie of setCookies) response.headers.append('set-cookie', cookie)
    return response
  }

  const response = await next()
  for (const cookie of setCookies) response.headers.append('set-cookie', cookie)
  return response
}) satisfies StartMiddleware
