import { defineConfig } from 'vite'
import solid from '@solidjs/vite-plugin'

/**
 * A nonce, not a description: one `vite build` is the unit of client/server
 * compatibility, so all this has to do is differ from the last one.
 *
 * It lives in the process environment rather than a module constant because Vite
 * configures each build environment (client, then SSR) separately and re-runs
 * this file for each — a module-scope random gives the two bundles *different*
 * ids, which would make every client look permanently stale. `??=` mints once
 * per `vite build` (or dev-server start) and both bundles read that one value.
 * See src/shared/build.ts.
 */
const buildId = (process.env.READER_BUILD_ID ??= crypto.randomUUID().slice(0, 8))

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
  plugins: [
    solid({
      ssr: true,
      serverFunctions: true,
      start: {
        middleware: './src/middleware.ts',
      },
    }),
  ],
  server: {
    port: 5173,
  },
  build: {
    // Bun builtins are not node: builtins, so Vite will not externalize them on
    // its own. Without this the SSR build tries to resolve `bun:sqlite`.
    rolldownOptions: {
      external: [/^bun(:|$)/],
    },
  },
  ssr: {
    external: ['bun', 'bun:sqlite'],
  },
})
