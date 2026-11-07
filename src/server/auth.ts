/**
 * Session auth: one HMAC-signed cookie, no sessions table (two accounts don't
 * pay for mid-TTL revocation). Passwords verify with argon2id (set via
 * scripts/set-password.ts).
 *
 * The second half of this module is the server-function gate. Server functions
 * are reachable directly at `/_server`, so middleware's redirect is not enough:
 * every export authorizes itself through `authed()`.
 */
import { timingSafeEqual } from 'node:crypto'

import { getRequestEvent } from '@solidjs/web'
import { eq } from 'drizzle-orm'
import type { z } from 'zod'

import type { UserId } from '../shared/ids'
import type { CookieJar } from './cookies'
import type { ReaderHandle } from './db'
import { users } from './db/schema'

export type SessionUser = { id: UserId; username: string }

export const SESSION_COOKIE = 'reader_session'
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

function secret(): string {
  const fromEnv = process.env.SESSION_SECRET
  if (fromEnv) return fromEnv
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET is required in production')
  }
  return 'dev-only-secret' // rotating per process in dev is fine
}

function hmac(payload: string): string {
  // Bun's HMAC entry point: CryptoHasher with a secret key.
  return new Bun.CryptoHasher('sha256', secret()).update(payload).digest('base64url')
}

export function signSession(user: SessionUser): string {
  const payload = Buffer.from(
    JSON.stringify({ id: user.id, username: user.username, exp: Date.now() + SESSION_TTL_MS }),
  ).toString('base64url')
  return `${payload}.${hmac(payload)}`
}

export function readSession(cookie: string | undefined): SessionUser | null {
  if (!cookie) return null
  const dot = cookie.lastIndexOf('.')
  if (dot < 0) return null
  const payload = cookie.slice(0, dot)
  const signature = cookie.slice(dot + 1)
  const expected = hmac(payload)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      id: string
      username: string
      exp: number
    }
    if (typeof data.exp !== 'number' || data.exp < Date.now()) return null
    return { id: data.id as UserId, username: data.username }
  } catch {
    return null
  }
}

export function sessionCookieOptions(): {
  httpOnly: true
  sameSite: 'lax'
  path: '/'
  maxAge: number
  secure: boolean
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
    secure: process.env.NODE_ENV === 'production',
  }
}

/** Verify a login attempt. Returns the user or null (never reveals which). */
export function verifyLogin(
  handle: ReaderHandle,
  username: string,
  password: string,
): SessionUser | null {
  const row = handle.db
    .select({ id: users.id, username: users.username, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.username, username.toLowerCase()))
    .get()
  if (!row || row.passwordHash === '') return null
  const ok = Bun.password.verifySync(password, row.passwordHash)
  return ok ? { id: row.id, username: row.username } : null
}

// ---- The server-function gate ----

/** A failure the caller sees as an HTTP status rather than a 500. */
export class HttpError extends Error {
  status: number

  constructor(status: number, message?: string) {
    super(message ?? `HTTP ${status}`)
    this.name = 'HttpError'
    this.status = status
  }
}

/** The request event, or a loud failure if called outside a request scope. */
export const requestEvent = () => {
  const event = getRequestEvent()
  if (!event) throw new Error('Not in a request scope')
  return event
}

/** The cookie jar middleware attached to this request. */
export const cookieJar = (): CookieJar => requestEvent().locals.cookies

export const currentUser = (): SessionUser | null => getRequestEvent()?.locals.user ?? null

export const requireUser = (): SessionUser => {
  const user = currentUser()
  if (!user) throw new HttpError(401, 'Not authenticated')
  return user
}

/**
 * Wraps a server function so a failure reaches the client as an HTTP status
 * rather than a 500: the RPC transport turns a thrown `Response` into its
 * status, and an `HttpError` into that same Response. Everything else is a real
 * bug and stays a 500.
 */
export const guarded =
  <A extends unknown[], R>(fn: (...args: A) => R) =>
  async (...args: A): Promise<Awaited<R>> => {
    try {
      return await fn(...args)
    } catch (error) {
      if (error instanceof HttpError) throw new Response(null, { status: error.status })
      throw error
    }
  }

/**
 * Wraps a server function so it receives the authenticated user in place of a
 * "current user" lookup, and rejects anonymous calls.
 *
 *   export const setStarred = authed(async ({ user }, ids, starred) => …)
 */
export const authed = <A extends unknown[], R>(
  fn: (context: { user: SessionUser }, ...args: A) => R,
) =>
  guarded(async (...args: A): Promise<Awaited<R>> => {
    const user = requireUser()
    return await fn({ user }, ...args)
  })

/**
 * Runtime validation for anything crossing the RPC boundary. Arguments arrive
 * from the wire, so a typed signature proves nothing about what was sent.
 */
export const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value)
  if (!result.success) throw new HttpError(400, `Invalid input: ${result.error.message}`)
  return result.data
}
