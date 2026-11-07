/**
 * The repository root, resolved once from this file's own location.
 *
 * Anything that needs `data/`, `drizzle/` or the import dump starts here instead
 * of counting `../` from wherever the caller happens to live — that arithmetic
 * silently points outside the repo as soon as a file changes depth.
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** src/server/repo-root.ts → the directory holding package.json. */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
