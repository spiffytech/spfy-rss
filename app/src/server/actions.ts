'use server'

/**
 * Every read and every mutation the reader performs, as typed RPC.
 *
 * Two rules hold for this file:
 *  - nothing is exported without `authed()` except the session functions
 *    (login, logout, register) and the signup-config probe, because `/_server`
 *    is a public endpoint;
 *  - arguments are validated with zod, because a typed signature says nothing
 *    about what the wire actually carried.
 */
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'

import {
  authed,
  cookieJar,
  guarded,
  HttpError,
  parse,
  requestEvent,
  SESSION_COOKIE,
  sessionCookieOptions,
  signSession,
  verifyLogin,
} from '../server/auth'
import { appDb } from '../server/db-app'
import { categories, users } from '../server/db/schema'
import {
  getAllFeedPrefs,
  getUserPrefs,
  markEntries,
  setFeedPrefs,
  setStarred as setStarredInDb,
  setUserPrefs,
  unsubscribeFeed,
} from '../server/query/mutations'
import {
  entriesByIds as entriesByIdsFromDb,
  panel as panelFromDb,
  queryView,
} from '../server/query/views'
import { epochMs, newUserId, type CategoryId, type EntryId, type FeedId } from '../shared/ids'
import { zodEntriesFilter, type EntriesFilter } from '../shared/filter'
import { DEFAULT_HIDE_EMPTY_FEEDS, resolveViewFilter, type FeedPrefs, type UserPrefs } from '../shared/prefs'
import { editFeed as editFeedInDb, subscribe as subscribeFeed } from '../server/fetch/subscribe'
import { importOpml as importOpmlFile } from '../server/opml'

const db = () => appDb().db

// ---- Session (the only unauthenticated exports) ----

export const login = guarded(async (username: string, password: string) => {
  const parsed = parse(
    z.object({ username: z.string().min(1), password: z.string().min(1) }),
    { username, password },
  )
  const user = verifyLogin(appDb(), parsed.username, parsed.password)
  if (!user) throw new HttpError(401, 'invalid credentials')
  const event = requestEvent()
  cookieJar().set(SESSION_COOKIE, signSession(user), sessionCookieOptions())
  event.locals.user = user
  return { authenticated: true as const, username: user.username }
})

export const logout = guarded(async () => {
  cookieJar().delete(SESSION_COOKIE)
  requestEvent().locals.user = null
  return { authenticated: false as const }
})

/** Is self-service registration open? Read per call so a restart alone isn't
 *  required to flip it in tests; env is still the only source. */
const signupEnabled = (): boolean => process.env.ALLOW_SIGNUP !== '0'

/** What the login page needs to decide whether to show the signup link. */
export const signupConfig = guarded(async () => ({ enabled: signupEnabled() }))

const signupSchema = z.object({
  username: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'letters, digits, dot, dash and underscore only'),
  password: z.string().min(8).max(256),
})

/**
 * Create an account and sign it in.
 *
 * Usernames are stored lowercase, matching `verifyLogin`'s lookup; a taken name
 * is a 409 rather than a silent login. Imported Miniflux users carry an empty
 * password hash, so they cannot be logged into (or duplicated into) this way
 * until `set-password` gives them one — the unique constraint still reserves
 * the name.
 */
export const register = guarded(async (username: unknown, password: unknown) => {
  if (!signupEnabled()) throw new HttpError(403, 'signups are closed')
  const parsed = parse(signupSchema, { username, password })
  const name = parsed.username.toLowerCase()
  const handle = db()
  if (handle.select({ id: users.id }).from(users).where(eq(users.username, name)).get()) {
    throw new HttpError(409, 'username taken')
  }
  const id = newUserId(epochMs(Date.now()))
  const passwordHash = await Bun.password.hash(parsed.password, { algorithm: 'argon2id' })
  try {
    handle.insert(users).values({ id, username: name, passwordHash, createdAt: epochMs(Date.now()) }).run()
  } catch (error) {
    // Two signups racing on one name: the unique index is the authority.
    if (String(error).includes('UNIQUE')) throw new HttpError(409, 'username taken')
    throw error
  }
  const user = { id, username: name }
  const event = requestEvent()
  cookieJar().set(SESSION_COOKIE, signSession(user), sessionCookieOptions())
  event.locals.user = user
  return { authenticated: true as const, username: name }
})

// ---- Reads ----

const cursorSchema = z
  .object({
    publishedAt: z.number(),
    id: z.string(),
    bucket: z.union([z.literal(0), z.literal(1)]).optional(),
  })
  .nullish()
  .transform((cursor) =>
    cursor ? { publishedAt: epochMs(cursor.publishedAt), id: cursor.id as EntryId, bucket: cursor.bucket } : null,
  )

/**
 * One round trip for the reading view's first paint: entries, sidebar, and the
 * per-feed prefs the controls need. The filter comes back resolved (this feed's
 * saved sort/read-items folded in), so the rows on screen and the controls that
 * claim to have produced them agree.
 */
/**
 * The three reads the reader makes. Separate on purpose: each has its own
 * lifecycle in the page (entries append, the panel is refreshed after writes,
 * prefs change on toggle), so none of them can invalidate another.
 */
export const viewEntries = authed(
  async ({ user }, filter: EntriesFilter, cursor: unknown, limit?: number) => {
  const handle = db()
  const feedPrefs = getAllFeedPrefs(handle, user.id)
  const resolved = resolveViewFilter(parse(zodEntriesFilter, filter ?? {}), feedPrefs)
  const at = parse(cursorSchema, cursor ?? null)
  return {
    ...queryView(handle, {
      userId: user.id,
      filter: resolved,
      cursor: at,
      limit: limit ?? undefined,
    }),
    filter: resolved,
  }
})

export const viewPanel = authed(async ({ user }, currentFeed: FeedId | null) => {
  const handle = db()
  // One read of each prefs table, carrying what the sidebar and the reading
  // controls need. This used to be a second call (`viewPrefs`) that re-read both
  // tables the entries read and this one had already loaded.
  const userPrefs = getUserPrefs(handle, user.id)
  return {
    ...panelFromDb(handle, {
      userId: user.id,
      hideEmptyFeeds: userPrefs.hideEmptyFeeds ?? DEFAULT_HIDE_EMPTY_FEEDS,
      currentFeed: currentFeed ?? null,
    }),
    userPrefs,
    feedPrefs: getAllFeedPrefs(handle, user.id),
  }
})

// ---- Mutations ----

const entryIds = z.array(z.string()).min(1).max(500)

export const setStatus = authed(
  async ({ user }, ids: unknown, status: 'read' | 'unread') => {
    const parsed = parse(z.object({ ids: entryIds, status: z.enum(['read', 'unread']) }), {
      ids,
      status,
    })
    const handle = db()
    markEntries(handle, {
      userId: user.id,
      entryIds: parsed.ids as EntryId[],
      status: parsed.status,
    })
    // Answer with the rows as stored: the client applies these instead of
    // re-reading the window, so a mark-read cannot lose the scroll position.
    return entriesByIdsFromDb(handle, { userId: user.id, ids: parsed.ids as EntryId[] })
  },
)

export const setStarred = authed(async ({ user }, ids: unknown, starred: boolean) => {
  const parsed = parse(z.object({ ids: entryIds, starred: z.boolean() }), { ids, starred })
  const handle = db()
  setStarredInDb(handle, {
    userId: user.id,
    entryIds: parsed.ids as EntryId[],
    starred: parsed.starred,
  })
  return entriesByIdsFromDb(handle, { userId: user.id, ids: parsed.ids as EntryId[] })
})
const feedPatchSchema = z
  .object({
    viewMode: z.enum(['expanded', 'list']).optional(),
    sort: z.enum(['oldest', 'newest']).optional(),
    hideReadItems: z.boolean().optional(),
    favorite: z.boolean().optional(),
  })
  .strict()

const userPatchSchema = z
  .object({
    hideEmptyFeeds: z.boolean().optional(),
    disabledAutoReadFeeds: z.array(z.string()).optional(),
  })
  .strict()

/** Per-feed view prefs (feedId given) or per-account prefs (omitted). */
export const setPrefs = authed(
  async ({ user }, feedId: FeedId | null, patch: Partial<FeedPrefs> | Partial<UserPrefs>) => {
    const handle = db()
    if (feedId) {
      setFeedPrefs(handle, user.id, feedId, parse(feedPatchSchema, patch))
    } else {
      const prefs = parse(userPatchSchema, patch)
      setUserPrefs(handle, user.id, {
        hideEmptyFeeds: prefs.hideEmptyFeeds,
        disabledAutoReadFeeds: prefs.disabledAutoReadFeeds?.map((id) => id as FeedId),
      })
    }
    return { ok: true as const }
  },
)

const titleSchema = z.string().min(1).max(500)

const folderFields = {
  categoryId: z.string().max(64).nullable().optional(),
  newCategoryTitle: z.string().trim().min(1).max(500).optional(),
}

const addFeedSchema = z
  .object({
    url: z.string().trim().min(1).max(2048),
    title: z.string().trim().max(500).optional(),
    ...folderFields,
  })
  .strict()

export const addFeed = authed(async ({ user }, input: unknown) => {
  const parsed = parse(addFeedSchema, input)
  return subscribeFeed(appDb(), {
    userId: user.id,
    url: parsed.url,
    title: parsed.title,
    categoryId: parsed.categoryId,
    newCategoryTitle: parsed.newCategoryTitle,
  })
})

const editFeedSchema = z
  .object({
    feedId: z.string().min(1).max(64),
    title: z.string().trim().min(1).max(500).optional(),
    feedUrl: z.string().trim().min(1).max(2048).optional(),
    ...folderFields,
  })
  .strict()

export const editFeed = authed(async ({ user }, input: unknown) => {
  const parsed = parse(editFeedSchema, input)
  return editFeedInDb(appDb(), {
    userId: user.id,
    feedId: parsed.feedId as FeedId,
    title: parsed.title,
    feedUrl: parsed.feedUrl,
    categoryId: parsed.categoryId,
    newCategoryTitle: parsed.newCategoryTitle,
  })
})

export const renameCategory = authed(async ({ user }, categoryId: CategoryId, title: string) => {
  const changed = db()
    .update(categories)
    .set({ title: parse(titleSchema, title) })
    .where(and(eq(categories.id, categoryId), eq(categories.userId, user.id)))
    .returning({ id: categories.id })
    .all()
  if (changed.length === 0) throw new HttpError(404, 'category not found')
  return { ok: true as const }
})

export const importOpml = authed(async ({ user }, text: unknown) => {
  const body = parse(z.string().min(1).max(5_000_000), text)
  return importOpmlFile(appDb(), { userId: user.id, text: body })
})

export const unsubscribe = authed(async ({ user }, feedId: FeedId) => {
  if (!unsubscribeFeed(appDb(), { userId: user.id, feedId })) {
    throw new HttpError(404, 'feed not found')
  }
  return { ok: true as const }
})
