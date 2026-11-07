/**
 * Cookies, without a framework.
 *
 * Start mode has no cookie helper, and the data layer should not know about
 * HTTP anyway. Middleware parses the incoming header once into a jar; anything
 * that wants to set a cookie appends to the same jar, and middleware copies the
 * finished `set-cookie` headers onto the outgoing response.
 */
export type CookieOptions = {
  httpOnly?: boolean
  sameSite?: 'lax' | 'strict' | 'none'
  path?: string
  maxAge?: number
  secure?: boolean
}

export type CookieJar = {
  get(name: string): string | undefined
  set(name: string, value: string, options?: CookieOptions): void
  delete(name: string, options?: CookieOptions): void
}

const parseCookieHeader = (header: string | null): Map<string, string> => {
  const jar = new Map<string, string>()
  if (!header) return jar
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const name = part.slice(0, eq).trim()
    if (name === '') continue
    // Values are URI-encoded by the serializer below; decode defensively.
    jar.set(name, decodeURIComponent(part.slice(eq + 1).trim()))
  }
  return jar
}

const serialize = (name: string, value: string, options: CookieOptions = {}): string => {
  const parts = [`${name}=${encodeURIComponent(value)}`]
  parts.push(`Path=${options.path ?? '/'}`)
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`)
  if (options.httpOnly !== false) parts.push('HttpOnly')
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`)
  if (options.secure) parts.push('Secure')
  return parts.join('; ')
}

/**
 * A jar over a request's cookie header plus the list of headers to send back.
 * `set-cookie` cannot be merged into one header, so they are collected.
 */
export const collectingCookieJar = (
  header: string | null,
): { jar: CookieJar; setCookies: string[] } => {
  const values = parseCookieHeader(header)
  const setCookies: string[] = []
  const jar: CookieJar = {
    get: (name) => values.get(name),
    set: (name, value, options) => {
      values.set(name, value)
      setCookies.push(serialize(name, value, options))
    },
    delete: (name, options) => {
      values.delete(name)
      setCookies.push(serialize(name, '', { ...options, maxAge: 0 }))
    },
  }
  return { jar, setCookies }
}
