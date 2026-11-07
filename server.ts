/**
 * Production entry. A boring Bun program: start the long-lived background work,
 * then hand every request to the built Solid start-mode handler, with the
 * hashed client assets served first.
 */
import { startScheduler } from './src/startup'

type Fetchable = { fetch: (request: Request) => Response | Promise<Response> }

const port = Number(process.env.PORT ?? 5173)
// Drizzle resolves migrations relative to a folder, and inside the server bundle
// import.meta.url points into dist/. Pin it to the app root once, before any
// handler or background job opens the database.
process.env.MIGRATIONS_DIR ??= new URL('./drizzle/', import.meta.url).pathname
const clientDir = new URL('./dist/client/', import.meta.url)

// Loaded at runtime so this file typechecks without a build present.
const handlerPath = new URL('./dist/server/server.js', import.meta.url).pathname
const app = (await import(handlerPath)) as Fetchable & { default?: Fetchable }
const fetch = app.fetch ?? app.default!.fetch

const serveStatic = async (pathname: string): Promise<Response | null> => {
  if (pathname === '/') return null
  const decoded = decodeURIComponent(pathname)
  if (decoded.split('/').includes('..')) return null

  const file = Bun.file(new URL('.' + decoded, clientDir))
  if (!(await file.exists())) return null

  // Hashed asset names are immutable; everything else revalidates.
  const immutable = decoded.startsWith('/assets/')
  return new Response(file, {
    headers: {
      'cache-control': immutable
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=0, must-revalidate',
      'last-modified': new Date(file.lastModified).toUTCString(),
    },
  })
}

startScheduler()

Bun.serve({
  port,
  fetch: async (request) => {
    const { pathname } = new URL(request.url)
    return (await serveStatic(pathname)) ?? fetch(request)
  },
})

console.log(`Miniflux Reader listening on http://localhost:${port}`)
