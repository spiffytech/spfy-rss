# spfy rss

A focused, self-hosted RSS reader that owns its own feed database: fetching,
scheduling and WebSub live here, not behind a Miniflux API. Built with **Bun +
Solid 2 (SolidStart-style server functions) + Vite + Tailwind 4 + SQLite
(Drizzle)**.

## Architecture

- **`src/server/`** — the whole backend:
  - `db/` — Drizzle schema, migrations, FTS5 search index.
  - `fetch/` — HTTP transport, feed parsing (feedsmith + Miniflux/NewsBlur
    quirk layer), feed discovery, icons, subscription edits.
  - `scheduler/` — adaptive poll loop: per-feed intervals learned from publish
    rate, failure backoff, Retry-After/cache freshness, `/health` heartbeat.
  - `websub/` — hub discovery, subscription leases, signed callbacks.
  - `import/` — one-shot Miniflux Postgres dump import (CLI).
  - `query/` — view windows, sidebar snapshots, mutations.
  - `opml.ts`, `auth.ts`, `actions.ts`.
- **`src/actions.ts` is the RPC surface.** Every export is a server function,
  authenticated through `authed()` except login/logout/register/signupConfig,
  and every argument is zod-validated (the `/_server` endpoint is public).
- **`src/pages` + `src/components`** — the Solid UI. The reading view's identity
  (feed, starred, search) is the URL query string.
- **`src/shared/`** — types and pure logic shared by server and client
  (filter, prefs, reading decisions, keyset cursors), unit-tested with `bun test`.
- **`src/lib/display/`** — untrusted feed HTML display pipeline. Entry content
  is inserted client-side only, through `Element.setHTML()` / DOMPurify, never
  server-rendered or via `{@html}`. One policy table feeds both sanitizers.

## Setup

```sh
bun install
cp .env.example .env   # then set SESSION_SECRET
```

Everything runs from the repository root: one package, one lockfile.

Environment (all documented, with defaults, in `.env.example`):

| Variable                                      | Meaning                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------ |
| `SESSION_SECRET`                              | HMAC key for session cookies. Required in production.                                |
| `READER_DB_PATH`                              | SQLite file (default `./data/reader.sqlite`).                                        |
| `PORT`                                        | HTTP port (default `5173`; the container sets `3000`).                               |
| `ALLOW_SIGNUP`                                | Self-service registration. On by default; set `0` to close it.                       |
| `MIGRATIONS_DIR`                              | Drizzle migrations folder (defaults to `./drizzle`).                                 |
| `READER_PUBLIC_URL`                           | Public origin WebSub hubs POST back to. Empty = no WebSub.                           |
| `SCHEDULER_ENABLED`                           | `0` pauses the poll loop (same as the `.scheduler-off` flag).                        |
| `SCHEDULER_ENTRY_FREQUENCY_MIN_INTERVAL`      | Fastest per-feed poll, minutes (5).                                                  |
| `SCHEDULER_ENTRY_FREQUENCY_MAX_INTERVAL`      | Slowest per-feed poll / staleness ceiling (1440).                                    |
| `SCHEDULER_ENTRY_FREQUENCY_FACTOR`            | Multiplies expected items/day (1).                                                   |
| `SCHEDULER_LEARNING_WINDOW_DAYS`              | Publish-rate learning window (90).                                                   |
| `SCHEDULER_RATE_HALF_LIFE_DAYS`               | Item-rate EMA half-life (7).                                                         |
| `SCHEDULER_FAILING_FEED_MAX_INTERVAL_MINUTES` | Failure-probe backoff ceiling (10080).                                               |
| `SCHEDULER_MAX_TICK_AGE_MINUTES`              | `/health/scheduler` 503 threshold (5).                                               |
| `POLLING_PARSING_ERROR_LIMIT`                 | Skip feeds at/above this error streak (0 = never).                                   |
| `MINIFLUX_SCHEDULER_NTFY_URL`                 | Legacy alias of `SCHEDULER_NTFY_URL` (ntfy topic for scheduler alerts; empty = off). |

## Run

```sh
bun run dev        # Vite + API + scheduler + Tailwind watch
bun run build      # CSS + client bundle → dist/
bun run start      # production: bun server.ts
```

| Script                 | What it does                                   |
| ---------------------- | ---------------------------------------------- |
| `bun run dev`          | Web, worker, CSS in parallel                   |
| `bun run build`        | `build:css` + Vite build                       |
| `bun run start`        | Serve `dist/` and the API                      |
| `bun run check`        | `typecheck` + `test`                           |
| `bun run test`         | `bun test` (server, shared, parser, scheduler) |
| `bun run test:webview` | Built app driven in a webview                  |
| `bun run typecheck`    | `tsc --noEmit`                                 |
| `bun run db:generate`  | Generate a Drizzle migration from `schema.ts`  |

The database migrates itself on startup. Runtime state (`data/reader.sqlite`
unless `READER_DB_PATH` says otherwise, plus the scheduler flags beside it) is
created on first run and git-ignored.

## Deploy

`Dockerfile` builds from the repository root; compose supplies `SESSION_SECRET`,
`READER_PUBLIC_URL` and the volume that backs `/data`.

## Authentication

Argon2id passwords, one HMAC-signed `httpOnly` session cookie (30 days), no
sessions table. Signup is available unless `ALLOW_SIGNUP=0`; new accounts start
with no feeds. Existing imported Miniflux users have an empty password hash and
must be given one:

```sh
echo -n 'correct horse' | bun run scripts/set-password.ts spiffy
```

## Features

- **Sidebar** — Home (favorite feeds with something unread), Starred, folders,
  unread counts, drag-to-resize, per-feed warning with the last fetch error.
- **Reading** — expanded or list view (`v`), star (`s`), read/unread (`m`),
  auto-read on scroll (per-feed opt-out), reading time above 5 minutes.
- **Navigation** — `j`/`k` or arrows, `o`/Enter opens the original, `Space`
  pages, `g`/`G` jump to top/bottom, `/` focuses search on desktop, `Shift+A`
  marks the loaded window read.
- **Search** — SQLite FTS5 over titles and bodies; bare terms, `"phrases"`,
  `-exclusions`, trailing `*` for type-ahead.
- **Subscriptions** — add/edit/unsubscribe, folders, OPML import/export, icon
  fetch, WebSub where a hub is advertised.
- **Infinite scroll** — keyset pages plus tail checks for late arrivals.
- **PWA** — installable manifest and icons. There is deliberately **no service
  worker and no offline cache**; Chrome and iOS install without one.

## Operations

- `GET /health` — liveness (process + database). Scheduler state rides in the
  body and never changes the status. This is the only endpoint a container
  healthcheck may act on.
- `GET /health/scheduler` — 503 once a `running` loop's last completed tick is
  older than the configured limit, or when no heartbeat exists at all. Paused
  (`data/.scheduler-off`) and disabled (`SCHEDULER_ENABLED=0`) answer 200 with
  the phase in the body. Alert on this; never restart on it.
- `GET /opml` — OPML export.
- `/api/websub/<token>` — hub callback.

## License

This project is licensed under the Mutualist License v1.2 (`MutuaL-1.2`).
See the [LICENSE.md](LICENSE.md) file for the full text.

![MutuaL-1.2](https://img.shields.io/badge/License-MutuaL--1.2-af2e1a?style=flat&labelColor=110402&link=https%3A%2F%2Fcodeberg.org%2FMutualism%2FMutualist-License)

### Mutualist License summary

**Permissions**

- ✅ Commercial use
- ✅ Private / internal use
- ✅ Modification
- ✅ Distribution (source and binaries)
- ✅ Network / SaaS use
- ✅ Patent use (from contributors, as described in the license)

**Conditions**

- ❗ Keep copyright and license notices
- ❗ Give appropriate credit (see "Credit" in the license)
- ❗ Share source for modified versions you distribute
- ❗ Share source for modified versions you let others use over a network
- ❗ License your changes under the Mutualist License too (same license)
- ❗ Don't add technical measures (like DRM) that stop users from exercising their rights
- ❗ Patent peace: you lose patent rights under this license if you start a patent attack over this software

**Limitations**

- ❌ No liability
- ❌ No warranty
- ❌ No trademark rights
- ❌ No implied endorsement
