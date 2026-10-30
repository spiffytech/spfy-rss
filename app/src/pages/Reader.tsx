import { Loading, Show, createEffect, createMemo, createSignal, onSettled } from "solid-js";
import { useLocation } from "@solidjs/router";

import { filterIdentity, hasView as sharedHasView, parseFilterFromUrl } from "../shared/filter";
import type { EntriesFilter } from "../shared/filter";
import { attachKeyboard } from "../lib/keyboard";
import { createReader } from "../lib/reader";
import { ReaderContext } from "../lib/reader-context";
import { Delayed } from "../components/Delayed";
import { FeedPanel } from "../components/FeedPanel";
import { FeedFormDialog } from "../components/FeedFormDialog";
import { Home } from "../components/Home";
import { EntryList } from "../components/EntryList";
import { watchScroll } from "../lib/observers";
import { installScrollMemory } from "../lib/scroll-memory";
import { TopToolbar } from "../components/TopToolbar";

/**
 * The reading surface: toolbar, sidebar (a static column on md+, an off-canvas
 * drawer on mobile), drag-to-resize handle, scroll container.
 *
 * The URL is the view state — which feed, category, section or search — so a
 * reload or the back button lands where the user left it. Everything else
 * (sorting, expansion, read-marking) is session state and never leaves the tab.
 */
export const ReaderPage = () => {
  const location = useLocation();
  const query = createMemo(() => location.query);

  /**
   * The filter is derived from the URL, so it exists on the server as well as in
   * the browser: there is no "set the filter after mount" step, and nothing to
   * get out of step with the address bar.
   */
  const filter = createMemo<EntriesFilter>(() => {
    const single: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(query())) {
      single[key] = Array.isArray(value) ? value[0] : value;
    }
    return parseFilterFromUrl(single);
  });

  /** One reader per render: its projection is the request's data. */
  const r = createReader(filter);
  const { setViewMode } = r;

  const [isDesktop, setIsDesktop] = createSignal(false);
  const [sidebarOpen, setSidebarOpen] = createSignal(false);

  /** A URL with no identity filter is the home page. */
  const hasView = (): boolean => sharedHasView(filter());

  let scrollEl: HTMLDivElement | undefined;

  // First paint and teardown. `onSettled` is Solid 2's onMount: it runs after
  // the initial reactive settle, and the function it returns is the cleanup.
  onSettled(() => {
    const mql = matchMedia("(min-width: 48rem)");
    const onChange = () => setIsDesktop(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);

    const stopKeys = attachKeyboard(r, () => {
      setViewMode(r.effectiveViewMode() === "expanded" ? "list" : "expanded");
    });
    const stopIdle = r.startIdleRefresh();
    const stopScroll = watchScroll(r);
    const stopMemory = installScrollMemory({
      viewKey: r.viewKey,
      wanted: () => r.session.wanted,
      ensureWindow: r.ensureWindow,
    });

    return () => {
      stopKeys();
      stopIdle();
      stopScroll();
      stopMemory();
      mql.removeEventListener("change", onChange);
    };
  });

  // Picking any sidebar entry closes the drawer. The data follows the URL on its
  // own — the projection is keyed on the filter — so this listener only closes
  // the drawer and needs no refetch of its own.
  createEffect(
    () => filterIdentity(filter()),
    () => {
      setSidebarOpen(false);
    },
  );

  // The list is replaced in exactly two cases, and both mean "start at the top":
  // you opened a different view, or you asked for a refresh (`listGen`). Keyed on
  // those, not on a separate counter — the events are the state.
  //
  // Seeded with the current values because Solid runs the apply once on creation:
  // a mount must not reset, or it overwrites the position the browser (or
  // ./scroll-memory) just restored.
  let lastViewKey = r.viewKey();
  let lastGen = r.session.listGen;
  createEffect(
    () => [r.viewKey(), r.session.listGen] as const,
    ([key, gen]) => {
      if (key === lastViewKey && gen === lastGen) return;
      lastViewKey = key;
      lastGen = gen;
      if (scrollEl) scrollEl.scrollTop = 0;
    },
  );

  // Desktop drag-to-resize of the sidebar: pure pointer events + a CSS var the
  // grid column reads.
  const MIN_W = 200;
  const MAX_W = 480;
  const STORAGE_KEY = "mf-sidebar-w";

  const sidebarResize = (node: HTMLElement): (() => void) => {
    let startX = 0;
    let startW = 280;
    const setWidth = (width: number) =>
      document.documentElement.style.setProperty(
        "--sidebar-w",
        `${Math.min(MAX_W, Math.max(MIN_W, width))}px`,
      );
    const onPointerDown = (event: PointerEvent) => {
      event.preventDefault();
      startX = event.clientX;
      startW =
        Number.parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w"),
        ) || 280;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      const move = (moveEvent: PointerEvent) => setWidth(startW + (moveEvent.clientX - startX));
      const up = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        document.removeEventListener("pointercancel", up);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        try {
          localStorage.setItem(
            STORAGE_KEY,
            getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w"),
          );
        } catch {
          // ignore: a full quota or a private window just means no remembered width
        }
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
      document.addEventListener("pointercancel", up);
    };
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const width = Number.parseInt(saved, 10);
        if (width > 0) setWidth(width);
      }
    } catch {
      // ignore
    }
    node.addEventListener("pointerdown", onPointerDown);
    return () => node.removeEventListener("pointerdown", onPointerDown);
  };

  return (
    <ReaderContext value={r}>
      <Loading
        fallback={
          <Delayed>
            <p class="p-6 text-sm text-gray-500" data-testid="reader-loading">
              Loading…
            </p>
          </Delayed>
        }
      >
        {/* Reading the projection is what suspends; with renderMode 'async' the
            server awaits it, so the document arrives with rows and the title. */}
        {/* The components below read the three projections; their first read is
            what the boundary awaits (and what 'async' makes the server wait for).
            No wrapper `Show`: re-reading a projection must not re-suspend. */}
          <div class="grid grid-rows-[auto_auto_1fr] app-container flex-1 min-h-0">
            <TopToolbar
              onToggleSidebar={() => setSidebarOpen(!sidebarOpen())}
              reading={hasView()}
            />

            {/* A rejected write is already rolled back by the framework; this says
                so instead of letting a row quietly flip back. */}
            <Show when={r.writeError()}>
              {(message) => (
                <div
                  role="alert"
                  data-testid="write-error"
                  class="mx-3 mb-2 flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
                >
                  <span class="flex-1">{message()}</span>
                  <button
                    type="button"
                    class="px-2 cursor-pointer"
                    aria-label="Dismiss"
                    onClick={() => r.dismissWriteError()}
                  >
                    ✕
                  </button>
                </div>
              )}
            </Show>

            <div class="relative grid grid-cols-1 md:grid-cols-[var(--sidebar-w)_1fr] gap-x-3 min-h-0 overflow-hidden">
              {/* Sidebar: static column on md+, off-canvas drawer on mobile toggled by
            display. The drawer is hidden until opened. */}
              <div
                class={[
                  "app-sidebar fixed inset-y-0 left-0 z-30 w-[var(--sidebar-w)] bg-white shadow-xl md:shadow-none md:static md:bg-transparent md:block md:m-0 overflow-y-auto",
                  { hidden: !sidebarOpen() && !isDesktop() },
                ]}
              >
                <div class="flex justify-end md:hidden p-2">
                  <button
                    type="button"
                    class="px-2 py-2 border border-gray-300 rounded-md"
                    onClick={() => setSidebarOpen(false)}
                  >
                    ✕
                  </button>
                </div>
                <FeedPanel />
              </div>

              {/* Scrim on mobile while the drawer is open. */}
              {sidebarOpen() && !isDesktop() && (
                <div
                  class="fixed inset-0 z-20 bg-black/30 md:hidden"
                  onClick={() => setSidebarOpen(false)}
                  role="presentation"
                />
              )}

              {/* Drag-to-resize handle (desktop only): sits in the grid gap. */}
              <div
                id="sidebar-resize"
                ref={sidebarResize}
                class="absolute top-0 bottom-0 z-40 hidden md:block cursor-col-resize touch-none hover:bg-cyan-700/20"
                style="left: calc(var(--sidebar-w) + 3px); width: 6px;"
                aria-hidden="true"
              />

              <div
                ref={(element) => {
                  scrollEl = element;
                }}
                class="overflow-y-auto min-h-0"
                data-testid="entry-scroll"
              >
                {/* No identity filter means no view: the home page is a set of links,
              not a list of entries. Everything below it in this component only
              makes sense once a feed, category, section or search is chosen. */}
                <Show when={hasView()} fallback={<Home />}>
                  <EntryList />
                </Show>
              </div>
            </div>
          </div>
        <FeedFormDialog />
      </Loading>
    </ReaderContext>
  );
};

export default ReaderPage;
