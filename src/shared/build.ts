/**
 * Which build this module graph came from.
 *
 * A nonce minted once per `vite build` (and once per dev-server start) and
 * injected into both the client and the SSR bundles through Vite's `define`
 * (see vite.config.ts). It deliberately says nothing about *what* was built —
 * only whether the client and the server in front of it came from the same one.
 * Two questions need that answer: "did a deploy happen under me?" and "is this
 * write failure a stale client rather than a real fault?".
 *
 * The `typeof` guard is for everything that runs from source under Bun
 * (`server.ts`, tests, scripts), where the define does not exist.
 */
declare const __BUILD_ID__: string | undefined

export const BUILD_ID: string = typeof __BUILD_ID__ === 'undefined' ? 'dev' : __BUILD_ID__
