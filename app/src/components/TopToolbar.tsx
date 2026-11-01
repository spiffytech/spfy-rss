import { Show } from "solid-js";
import { useSearchParams } from "@solidjs/router";

import { createSearch } from "../lib/search";
import { useReader } from '../lib/reader-context'
import { FeedMenu } from "./FeedMenu";

/**
 * The reading view's header: sidebar toggle (mobile), brand (desktop), the feed
 * menu, prev/next, and — on desktop only, where there is room — mark-all-read
 * and the search box.
 *
 * Mobile deliberately has no search or ⋯ button: both actions live in the feed
 * menu popover, which leaves the header three touch targets wide instead of six.
 */
export const TopToolbar = (props: { onToggleSidebar: () => void; reading: boolean }) => {
  const r = useReader()
  const { markDisplayed, moveAndRead } = r
  const [, setSearchParams] = useSearchParams();
  // Debounced typing writes the URL; the URL is the search state.
  const search = createSearch(r, (term) =>
    setSearchParams({ search: term, cursor: undefined }, { replace: true }),
  );

  const onMarkAllRead = (): void => {
    // Explicit-ID semantics: marks exactly the IDs this view fetched (the loaded
    // windows) — never hidden rows, never late arrivals.
    markDisplayed();
  };

  return (
    <header class="flex flex-nowrap items-center gap-x-2 min-w-0 px-2 py-2 border-b-2 border-line mb-2">
      {/* Mobile hamburger: toggles the sidebar drawer */}
      <button
        type="button"
        class="toolbar-btn md:hidden"
        title="Toggle feed list"
        aria-label="Toggle feed list"
        onClick={props.onToggleSidebar}
      >
        &#9776;
      </button>

      <a href="/" class="hidden md:inline shrink-0 font-semibold text-lg mr-auto">
        Miniflux Reader
      </a>

      <FeedMenu />

      {/* Prev/next and mark-all-read act on an entry list. On the home page
          there is none, so they are not rendered at all rather than sitting
          there doing nothing. */}
      <Show when={props.reading}>
        <button
          type="button"
          class="toolbar-btn"
          title="Previous (k)"
          aria-label="Previous entry (k)"
          onClick={() => moveAndRead(-1)}
        >
          <span aria-hidden="true">▲</span>
          <span class="hidden md:inline">&nbsp;Prev</span>
        </button>
        <button
          type="button"
          class="toolbar-btn"
          title="Next (j)"
          aria-label="Next entry (j)"
          onClick={() => moveAndRead(1)}
        >
          <span aria-hidden="true">▼</span>
          <span class="hidden md:inline">&nbsp;Next</span>
        </button>

        <button
          type="button"
          class="toolbar-btn hidden md:inline-flex"
          title="Mark all read (Shift+A)"
          aria-label="Mark all read"
          onClick={onMarkAllRead}
        >
          ✓
        </button>
      </Show>

      <input
        id="reader-search"
        type="search"
        placeholder="Search…"
        class="hidden md:block flex-1 max-w-sm min-w-[100px] min-h-11 px-3 py-2 border border-line rounded-lg"
        value={search.text()}
        onInput={(event) => search.onSearchInput(event.currentTarget.value)}
      />
    </header>
  );
};

export default TopToolbar;
