import type { JSX } from '@solidjs/web'
import { Show, onSettled } from 'solid-js'
import { Router } from './router.tsx'
import { updateAvailable, watchVersion } from './lib/version'

/**
 * The app shell. Chrome (toolbar, sidebar, reading pane) belongs to the reader
 * page itself — the login screen has none — so this only mounts the router, and
 * the one thing that outlives a page: the notice that this tab is running an
 * old build.
 */
export default function App() {
  onSettled(() => {
    // <lite-youtube> elements are created by the display pipeline
    // (lib/display/render.ts), but the element is only *defined* by importing
    // the package. That module registers a custom element and so touches
    // `document` at import time: browser-only, hence here rather than in
    // render.ts (which the server also loads).
    void import('lite-youtube-embed')

    const stopVersionWatch = watchVersion()
    return () => stopVersionWatch()
  })

  return (
    <>
      <Router>{(props: { children?: JSX.Element }) => <>{props.children}</>}</Router>

      {/* Detect-and-say: never reloads by itself, because "a safe moment" is a
          moving target (a half-typed feed, a write in flight). The reader
          decides when. */}
      <Show when={updateAvailable()}>
        <div class="fixed inset-x-0 bottom-3 z-50 flex justify-center px-3 pointer-events-none">
          <button
            type="button"
            data-testid="update-available"
            class="pointer-events-auto flex items-center gap-2 rounded-full border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 shadow-lg cursor-pointer hover:bg-amber-100"
            onClick={() => location.reload()}
          >
            <span aria-hidden="true">↻</span>
            <span>Updated version available — reload</span>
          </button>
        </div>
      </Show>
    </>
  )
}
