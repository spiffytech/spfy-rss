import { startScheduler } from './startup'

process.env.MIGRATIONS_DIR ??= new URL('../drizzle/', import.meta.url).pathname

// Dev only: Vite owns the web server, so this process exists to own the
// scheduler (and the SQLite writes it makes) without HMR reloading it.
startScheduler()
