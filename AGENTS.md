Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

This project is in a public repo.

## Untrusted feed HTML (hard rule)

Entry content is untrusted feed HTML. It is inserted **client-side only**,
through `Element.setHTML()` / DOMPurify (`src/lib/display/render.ts` —
`transformEntryContent` then `sinkEntryContent`), never server-rendered and
never via `{@html}`: the Sanitizer API is DOM-time only, so a server render is
an unguarded sink. The display policy lives in one table
(`src/lib/display/policy.ts`) that both sanitizer adapters read.

## Tests & checks

All commands run from the repository root:

```sh
bun test                    # unit suite (bun:test) — hermetic: in-memory DBs + fixtures,
                            # no network, never touches production data or accounts
bun run test:webview        # real-browser behavior suite (Bun.WebView → headless Chrome on
                            # Linux, WKWebView on macOS): rebuilds, boots the app, exercises
                            # the Sanitizer/display pipeline. Needs Chrome; skip on a bare box.
bun run typecheck           # types (tsc --noEmit; Solid's JSX types come from @solidjs/web)
```

Non-obvious tooling facts (all learned the hard way):

- Dev/build must run under Bun (`bun --bun vite …`, already wired into `bun run dev|build`):
  Vite's SSR environment loads server modules itself, and `bun:sqlite` only resolves when the
  Vite process _is_ Bun. `bun:sqlite` also stays lazy (`createRequire`) in
  `src/server/db/index.ts`.
- `bun` builtins must be externalized twice in `vite.config.ts` — `ssr.external` (strings) and
  `build.rolldownOptions.external` — or the SSR build tries to resolve `bun:sqlite`.
- `server.ts` pins `MIGRATIONS_DIR` to the app root: drizzle resolves migrations by folder, and
  inside the built server bundle `import.meta.url` points into `dist/`.
- `test/webview.test.ts` is the only place the display pipeline is proven against a real
  browser engine — run it after touching `src/lib/display/`. Its `signIn` helper drives the real
  login form (`view.click`/`view.type`): a programmatic `input.value = x` does not reach Solid's
  event handler, and the server functions' wire protocol is internal.
- The webview suite spawns its own server on a fixed port. A server left behind by an
  interrupted run would serve _its_ database, so the suite refuses to start if the port
  answers (`kill` the stray `bun server.ts` first).
- Want a throwaway login for manual poking? `bun run scripts/seed-test-user.ts` seeds a
  passwordless `test` user from the real account's feeds (`--delete` removes it). Never keep
  a passwordless account on the public login form.

One package lives at the repository root: `bun run dev` boots the reader, reading
`data/reader.sqlite` (or `READER_DB_PATH`). `dev` runs two processes: Vite (the web
server, with SSR) and a watched `src/startup-cli.ts` that owns the scheduler, so HMR
never reloads it into a second polling loop.

## Stack

Solid 2 start mode + `Bun.serve` — no SvelteKit, no Hono. The port is done; treat this as the
shape to keep:

| Piece                                               | Where                                                    |
| --------------------------------------------------- | -------------------------------------------------------- |
| HTML shell                                          | `src/Document.tsx`                                       |
| Router (explicit route list)                        | `src/router.tsx`                                         |
| Auth, authz gate, `renderMode`                      | `src/middleware.ts` + `authed()` in `src/server/auth.ts` |
| Reads and mutations                                 | `'use server'` functions in `src/server/actions.ts`      |
| Plain URL endpoints (WebSub, `/health`, feed icons) | `src/api-routes.ts`, mounted from middleware             |
| Client state                                        | `src/lib/reader.ts` (projections + session)              |
| Production entry / dev worker                       | `server.ts` / `src/startup-cli.ts`                       |

Rules that survived the port:

- `/_server` is never redirected to `/login`: every export gates itself with `authed()`, and a
  redirect there hands the RPC client an HTML page. A failure is thrown as an `HttpError` and
  turned into a `Response` status by `guarded()` — the RPC transport reads the status from a
  thrown `Response`, and doesn't carry messages.
- Arguments cross the wire, so a typed signature proves nothing: validate with zod (`parse()`).
- Entry bodies are client-only (never server-rendered), same rule as above.
- `renderMode: 'async'` for page renders — the chrome lives outside any boundary, so streaming
  only paints a flash.
- Read the `using-solid-2` skill before writing components. In Solid 2: `onMount` is
  `onSettled` (return the cleanup), `onCleanup` in a component body also runs when the _server_
  disposes its render owner (`window` is undefined there), store setters take a draft callback
  only, and a `ref` callback runs before the element is attached — resolve DOM ancestry at use
  time, not in the ref.

The scheduler lives in `src/server/scheduler/` and is ON by default: it
polls feeds on learned bells, appends arrivals to the open view, and reports
`/health/scheduler` 503 when a tick goes stale (`/health` is liveness + a
database probe, for the container healthcheck). Pause at runtime with
`touch data/.scheduler-off`; disable with `SCHEDULER_ENABLED=0`. Design doc +
port deltas: `docs/feed-scheduler.md`.
