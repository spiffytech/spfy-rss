/**
 * Behavior suite: real browser, real sanitization (Bun.WebView).
 *
 * Runs on demand (`bun run test:webview`): it needs a display/headless-Chrome
 * environment, so it is skipped in plain `bun test` runs. On Linux Bun.WebView
 * drives Chrome — exercising the `Element.setHTML()` sink; on macOS it is
 * WKWebView — exercising the DOMPurify fallback. Both paths run the same
 * assertions, and the suite reports which sink was live.
 *
 * The fixture entry is hostile feed HTML: script, event handler, javascript:
 * URL, relative URL, and a YouTube iframe (must become <lite-youtube>).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase } from "../src/server/db";
import { epochMs, newCategoryId, newEntryId, newFeedId, newUserId } from "../src/shared/ids";

const enabled = process.env.WEBVIEW === "1";
const PORT = 4820;
const BASE = `http://localhost:${PORT}`;

const HOSTILE_HTML = [
  '<p onclick="alert(1)">hello</p>',
  "<script>alert(2)</script>",
  '<iframe src="https://www.youtube.com/watch?v=dQw4w9WgXcQ"></iframe>',
  '<a href="/relative">rel</a>',
  '<img src="javascript:alert(3)">',
  // xkcd's shape: the image title is the joke (Miniflux's add_image_title).
  '<img src="https://imgs.xkcd.com/comics/standards.png" title="Alt text: the comic joke">',
].join("");

let server: ReturnType<typeof spawn> | undefined;
let fixtureDbPath = "";

beforeAll(async () => {
  if (!enabled) return;
  // A server left behind by an interrupted run would silently serve *its*
  // database — the suite would read another run's state and fail in ways that
  // look like application bugs.
  const leftover = await fetch(`${BASE}/health`).then(
    (res) => res.ok,
    () => false,
  );
  if (leftover) throw new Error(`port ${PORT} is already serving — kill the leftover server first`);
  const dbPath = join(mkdtempSync(join(tmpdir(), "webview-db-")), "reader.sqlite");
  fixtureDbPath = dbPath;
  const handle = openDatabase(dbPath);
  const now = epochMs(Date.now());
  const userId = newUserId(now);
  handle.sqlite.run(
    "INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)",
    [userId, "spiffy", Bun.password.hashSync("correct-horse", { algorithm: "argon2id" }), now],
  );
  handle.sqlite.run("INSERT INTO categories (id, user_id, title, created_at) VALUES (?, ?, ?, ?)", [
    newCategoryId(now),
    userId,
    "Tech",
    now,
  ]);
  const feedId = newFeedId(now);
  handle.sqlite.run(
    "INSERT INTO feeds (id, user_id, category_id, title, feed_url, site_url, created_at) VALUES (?, ?, (SELECT id FROM categories), ?, ?, ?, ?)",
    [feedId, userId, "Blog", "https://example.com/feed", "https://example.com/", now],
  );
  // A hostile TITLE, not just hostile content: titles are rendered as text, so
  // nothing here may become markup or execute. (TITLE-XSS-MARKER locates it.)
  const HOSTILE_TITLE = '<img src=x onerror="window.__titleXss=1"> TITLE-XSS-MARKER';
  handle.sqlite.run(
    `INSERT INTO entries (id, user_id, feed_id, hash, title, url, content, published_at, created_at, changed_at)
     VALUES (?, ?, ?, 'h1', ?, 'https://xkcd.com/927/', ?, ?, ?, ?)`,
    [newEntryId(now), userId, feedId, HOSTILE_TITLE, HOSTILE_HTML, now, now, now],
  );
  // A window's worth of plain rows (VIEW_PAGE_SIZE = 100) so the sentinel has a
  // second page to pull and auto-read has entries to scroll past.
  const insert = handle.sqlite.prepare(
    `INSERT INTO entries (id, user_id, feed_id, hash, title, content, published_at, created_at, changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 1; i <= 119; i++) {
    // The entry at #50 carries a titled image on a NON-comic URL: the rewrite
    // must leave it alone (the rule keys off the entry's domain). #50 is inside
    // the first window whichever way the list is ordered.
    const content =
      i === 50
        ? '<p>body</p><img src="https://example.com/x.png" title="Not a comic">'
        : "<p>body</p>";
    insert.run(
      newEntryId(now),
      userId,
      feedId,
      `plain-${i}`,
      `Plain ${i}`,
      content,
      now + i * 1000,
      now,
      now,
    );
  }
  handle.sqlite.run("UPDATE feeds SET parsing_error_count = 1 WHERE id = ?", [feedId]);
  handle.sqlite.close();

  server = spawn("bun", ["server.ts"], {
    env: {
      ...process.env,
      READER_DB_PATH: dbPath,
      PORT: String(PORT),
      SESSION_SECRET: "webview-smoke",
      NODE_ENV: "production",
      SCHEDULER_ENABLED: "0",
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
});

afterAll(() => {
  if (typeof Bun !== "undefined" && "WebView" in Bun) Bun.WebView.closeAll();
  server?.kill();
});

const it = enabled ? test : test.skip;

/** Poll a page-side expression until it is truthy (or the deadline passes). */
const until = (script: string, timeoutMs = 15_000): string => `
  (() => {
    const deadline = Date.now() + ${timeoutMs}
    return new Promise((resolve) => {
      const tick = () => {
        const v = (() => { ${script} })()
        if (v) return resolve(v)
        if (Date.now() > deadline) return resolve(v)
        setTimeout(tick, 100)
      }
      tick()
    })
  })()
`;

/**
 * A deliberately simple HTTP cache in front of the app.
 *
 * This is the stale-document failure made deterministic. A real browser may or
 * may not reuse a document heuristically; a CDN configured with "cache
 * everything" will, and so will some tab-restore paths. The proxy replays a
 * document only when the response gave it permission to store it (no
 * `no-cache`/`no-store`/`must-revalidate`/`max-age=0`), so the header contract
 * is what the test exercises.
 */
const startCacheProxy = (upstream: string) => {
  let staleHits = 0;
  const store = new Map<string, { status: number; headers: Headers; body: ArrayBuffer }>();
  const mayStore = (cacheControl: string | null): boolean => {
    if (!cacheControl) return true;
    const value = cacheControl.toLowerCase();
    return (
      !value.includes("no-store") &&
      !value.includes("no-cache") &&
      !value.includes("must-revalidate") &&
      !/(^|,)\s*max-age=0\b/.test(value)
    );
  };

  const proxy = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const key = url.pathname + url.search;
      const isDocument =
        req.method === "GET" &&
        !url.pathname.startsWith("/_server") &&
        !url.pathname.startsWith("/assets") &&
        !url.pathname.startsWith("/api/");

      if (isDocument) {
        const hit = store.get(key);
        if (hit) {
          staleHits++;
          return new Response(hit.body.slice(0), {
            status: hit.status,
            headers: new Headers(hit.headers),
          });
        }
      }

      const upstreamResponse = await fetch(`${upstream}${key}`, {
        method: req.method,
        headers: req.headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
        redirect: "manual",
      });
      const body = await upstreamResponse.arrayBuffer();
      const headers = new Headers(upstreamResponse.headers);
      if (
        isDocument &&
        upstreamResponse.status === 200 &&
        (headers.get("content-type") ?? "").includes("text/html") &&
        mayStore(headers.get("cache-control"))
      ) {
        store.set(key, { status: upstreamResponse.status, headers, body: body.slice(0) });
      }
      return new Response(body, { status: upstreamResponse.status, headers });
    },
  });

  return {
    base: `http://localhost:${proxy.port}`,
    hits: () => staleHits,
    reset: () => {
      staleHits = 0;
    },
    stop: () => proxy.stop(true),
  };
};

/**
 * Signs the fixture account in through the real login form.
 *
 * The suite used to call the SvelteKit `/api/login` endpoint directly. Those
 * endpoints are gone — every read and mutation is a Solid start-mode server
 * function now, and its wire protocol is internal. Driving the form with real
 * input (a programmatic `.value =` does not reach Solid's handler) is both more
 * faithful and immune to that protocol changing.
 */
/** The fixture's only feed, read from the database so the URL is stable even
 *  when the sidebar hides it (hideEmptyFeeds, everything read). */
const fixtureFeedId = (): string => {
  const handle = openDatabase(fixtureDbPath);
  const row = handle.sqlite.query("SELECT id FROM feeds LIMIT 1").get() as { id: string };
  handle.sqlite.close();
  return row.id;
};

/** Everything unread again — tests share one database, and a reading-surface
 *  test needs rows to read. */
const restoreUnread = (): void => {
  const handle = openDatabase(fixtureDbPath);
  handle.sqlite.run("UPDATE entries SET status = 'unread'");
  handle.sqlite.close();
};

/** Open a feed's reading view. Replaces `navigate("/")`, which is now the home
 *  page (links, not entries). */
const openFeedView = async (
  view: Bun.WebView,
  feedId = fixtureFeedId(),
  base = BASE,
): Promise<void> => {
  await view.navigate(`${base}/?feed=${feedId}`);
  await view.evaluate(
    until('const n = document.querySelectorAll("[data-entry-id]").length; return n > 0 ? n : 0'),
  );
};

const signIn = async (view: Bun.WebView, base = BASE): Promise<void> => {
  await view.navigate(`${base}/login`);

  // Chrome is spawned once per process and keeps its cookie store, so a later
  // test's fresh WebView may already be signed in — in which case /login
  // redirects to the reader and there is no form to fill.
  const landed = await view.evaluate(`
    (() => {
      const deadline = Date.now() + 10000
      return new Promise((resolve) => {
        const tick = () => {
          if (document.querySelector('input[name="username"]')) return resolve('login')
          if (document.querySelector('[data-testid="feed-menu-trigger"]')) return resolve('reader')
          if (Date.now() > deadline) return resolve('none')
          setTimeout(tick, 50)
        }
        tick()
      })
    })()
  `);
  if (landed === "reader") return;
  if (landed !== "login") throw new Error(`login page did not render (got ${landed})`);

  await view.click('input[name="username"]');
  await view.type("spiffy");
  await view.click('input[name="password"]');
  await view.type("correct-horse");
  await view.click('button[type="submit"]');

  // The reader shell mounts after the login RPC resolves and the router lands on /.
  const ready = await view.evaluate(`
    (() => {
      const deadline = Date.now() + 10000
      return new Promise((resolve) => {
        const tick = () => {
          const shell = document.querySelector('[data-testid="feed-menu-trigger"]')
          const sidebar = document.querySelector('[data-testid="feed-panel"]')
          if (shell && sidebar) return resolve(true)
          if (Date.now() > deadline) return resolve(false)
          setTimeout(tick, 50)
        }
        tick()
      })
    })()
  `);
  if (!ready) throw new Error("reader did not render after sign-in");
};

it("display pipeline sanitizes hostile HTML in a real browser", async () => {
  const view = new Bun.WebView({ width: 1100, height: 800 });
  try {
    await signIn(view);
    await openFeedView(view);
    // Wait for the entry card to fetch and sink its body.
    await view.evaluate(`
      (() => {
        const deadline = Date.now() + 5000
        return new Promise((resolve) => {
          const tick = () => {
            const content = document.querySelector('.reading')
            if ((content && content.childNodes.length > 0) || Date.now() > deadline) return resolve(true)
            setTimeout(tick, 50)
          }
          tick()
        })
      })()
    `);

    const report = (await view.evaluate(`
      (() => {
        const content = document.querySelector('.reading')
        const link = content && content.querySelector('a')
        return {
          sink: typeof Element.prototype.setHTML === 'function' ? 'setHTML' : 'dompurify',
          probe: (() => {
            const out = {}
            try {
              const a = document.createElement('div')
              a.setHTML('<lite-youtube videoid="x"></lite-youtube><b onclick="y">z</b>', {
                sanitizer: new Sanitizer({
                  elements: ['lite-youtube', 'b'],
                  attributes: { 'lite-youtube': ['videoid'], b: [] },
                  allowCustomElements: true,
                }),
              })
              out.policyShape = a.innerHTML
            } catch (e) {
              out.policyError = String(e)
            }
            const b = document.createElement('div')
            b.setHTML('<lite-youtube videoid="x"></lite-youtube><a href="https://x.example/y">z</a>')
            out.defaultShape = b.innerHTML
            const c = document.createElement('div')
            c.setHTML('<lite-youtube videoid="x"></lite-youtube>', {
              sanitizer: new Sanitizer({
                elements: [{ name: 'lite-youtube', attributes: ['videoid'] }, 'b'],
                allowCustomElements: true,
              }),
            })
            out.elementObjectsShape = c.innerHTML
            const d = document.createElement('div')
            d.setHTML('<foo-bar>x</foo-bar><b>ok</b>', {
              sanitizer: new Sanitizer({
                elements: [{ name: 'lite-youtube', attributes: ['videoid'] }, 'b'],
                allowCustomElements: true,
              }),
            })
            out.unlistedCustomAllowed = d.innerHTML
            const e = document.createElement('div')
            e.setHTML('<foo-bar>x</foo-bar><lite-youtube videoid="y"></lite-youtube><b>ok</b>', {
              sanitizer: new Sanitizer({
                elements: [{ name: 'lite-youtube', attributes: ['videoid'] }, 'b'],
                allowCustomElements: false,
              }),
            })
            out.customFalseShape = e.innerHTML
            return out
          })(),
          contentHtml: content ? content.innerHTML : null,
          path: location.pathname,
          articles: document.querySelectorAll('article').length,
          mainText: (document.querySelector('main') || document.body).innerText.slice(0, 200),
          diag: window.__diag || null,
          sidebarPanel: !!document.querySelector('[data-testid="feed-panel"]'),
          sections: document.querySelector('[data-testid="feed-panel"]')?.textContent?.includes('Sections') ?? false,
          hasLatest: document.querySelector('[data-testid="feed-panel"]')?.textContent?.includes('Latest') ?? false,
          hasStarred: document.querySelector('[data-testid="feed-panel"]')?.textContent?.includes('Starred') ?? false,
          hasBrand: document.body.textContent?.includes('Miniflux Reader') ?? false,
          feedMenu: !!document.querySelector('[data-testid="feed-menu-trigger"]'),
          bodyOverflow: getComputedStyle(document.body).overflow,
          documentScrolls: (document.scrollingElement?.scrollHeight ?? 0) > window.innerHeight + 1,
          listScrolls: (() => {
            const el = document.querySelector('[data-testid="entry-scroll"]')
            if (!el) return false
            el.scrollTop = 50
            return el.scrollTop > 0
          })(),
          sinkFallback: !!content && content.hasAttribute('data-sink-fallback'),
          sinkError: content ? content.getAttribute('data-sink-error') : null,
          hasScript: !!content && !!content.querySelector('script'),
          hasOnclick: !!content && !!content.querySelector('[onclick]'),
          hasJsUrl: !!content && Array.from(content.querySelectorAll('img')).some((i) => (i.getAttribute('src') || '').startsWith('javascript:')),
          imgLoading: content?.querySelector('img')?.getAttribute('loading') ?? null,
          hasLiteYoutube: !!content && !!content.querySelector('lite-youtube'),
          liteVideoId: content && content.querySelector('lite-youtube') ? content.querySelector('lite-youtube').getAttribute('videoid') : null,
          // The element existing is not enough: the lite-youtube-embed module must
          // have been imported, or the custom element never upgrades and nothing
          // renders. It builds light DOM (a play button), not a shadow root.
          liteDefined: !!customElements.get('lite-youtube'),
          liteUpgraded: !!(content && content.querySelector('lite-youtube .lyt-playbtn')),
          // …and its stylesheet must be loaded too: the package ships the CSS as a
          // separate file (its "style" field), unstyled the poster never appears.
          // …and the package's stylesheet must be applied: it ships the CSS as a
          // separate file (its "style" field). Unstyled, the element stays
          // display:inline with no poster — just a bare "Play" button.
          liteStyled: (() => {
            const el = content && content.querySelector('lite-youtube')
            return !!el && getComputedStyle(el).display === 'block'
          })(),
          // Miniflux's add_image_title: the comic image's title (xkcd's joke)
          // becomes a visible caption, and the tooltip is dropped.
          comicCaption: content ? (content.querySelector('figcaption')?.textContent ?? null) : null,
          comicImgTitle: content?.querySelector('figure img')?.getAttribute('title') ?? null,
          // Titles are text: a hostile title must not create elements or run.
          titleText: (() => {
            const a = [...document.querySelectorAll('.msubject')].find((el) =>
              (el.textContent ?? '').includes('TITLE-XSS-MARKER'),
            )
            return a ? a.textContent : null
          })(),
          titleImg: !!document.querySelector('.msubject img'),
          titleXss: !!window.__titleXss,
          linkHref: link ? link.getAttribute('href') : null,
          warnEmoji: /\\u26A0\\uFE0F/.test(document.body.textContent ?? ''),
          warnBare: /\\u26A0(?!\\uFE0F)/.test(document.body.textContent ?? ''),
        }
      })()
    `)) as {
      sink: string;
      probe: Record<string, string>;
      contentHtml: string | null;
      sinkFallback: boolean;
      sinkError: string | null;
      path: string;
      articles: number;
      mainText: string;
      diag: unknown;
      sidebarPanel: boolean;
      sections: boolean;
      hasLatest: boolean;
      hasStarred: boolean;
      hasBrand: boolean;
      feedMenu: boolean;
      bodyOverflow: string;
      documentScrolls: boolean;
      listScrolls: boolean;
      hasScript: boolean;
      hasOnclick: boolean;
      hasJsUrl: boolean;
      imgLoading: string | null;
      hasLiteYoutube: boolean;
      liteVideoId: string | null;
      liteDefined: boolean;
      liteUpgraded: boolean;
      liteStyled: boolean;
      comicCaption: string | null;
      comicImgTitle: string | null;
      titleText: string | null;
      titleImg: boolean;
      titleXss: boolean;
      linkHref: string | null;
      warnEmoji: boolean;
      warnBare: boolean;
    };

    console.log(`display sink under test: ${report.sink}`);
    console.log("sanitizer probe:", JSON.stringify(report.probe));
    console.log(
      "content html:",
      JSON.stringify(report.contentHtml),
      "fallback:",
      report.sinkFallback,
      "error:",
      report.sinkError,
      "path:",
      report.path,
    );
    console.log(
      "diag:",
      JSON.stringify(report.diag),
      "articles:",
      report.articles,
      "main:",
      JSON.stringify(report.mainText),
    );
    const pencil = (await view.evaluate(`
      (() => {
        const b = document.querySelector('button[title="Edit feed"]')
        if (!b) return { exists: false }
        const r = b.getBoundingClientRect()
        const cs = getComputedStyle(b)
        return { exists: true, w: r.width, h: r.height, x: r.x, y: r.y, opacity: cs.opacity, display: cs.display, visibility: cs.visibility, text: b.textContent }
      })()
    `)) as Record<string, unknown>;
    console.log("pencil probe:", JSON.stringify(pencil));
    // Click the hover-pencil: the edit form must open with the URL field focused.
    const editFocus = (await view.evaluate(`
      (() => {
        document.querySelector('button[title="Edit feed"]').click()
        return new Promise((resolve) => {
          const deadline = Date.now() + 2000
          const tick = () => {
            const input = document.querySelector('dialog[open] #feed-url')
            if (input && document.activeElement === input) return resolve({ found: true, focused: true })
            if (Date.now() > deadline) return resolve({ found: !!input, focused: false })
            setTimeout(tick, 25)
          }
          tick()
        })
      })()
    `)) as { found: boolean; focused: boolean };
    console.log("edit focus probe:", JSON.stringify(editFocus));
    expect(report.hasScript).toBe(false); // <script> stripped
    // The chrome itself — the navbar and sidebar the old app had (regression
    // guard for the port: these must survive any future restyle pass).
    expect(report.sidebarPanel).toBe(true); // FeedPanel aside present
    expect(report.sections).toBe(true); // "Sections" heading
    expect(report.hasLatest).toBe(false); // no aggregate row: home is a link list
    expect(report.hasStarred).toBe(true); // Starred row
    expect(report.hasBrand).toBe(true); // "Miniflux Reader" brand
    expect(report.feedMenu).toBe(true); // feed-menu trigger (per-feed options)
    // Scrolling contract: the document never scrolls; the panes do. Auto-read's
    // scroll listener, next/prev scrollToEntry and the sidebar all ride on it.
    expect(report.bodyOverflow).toBe("hidden");
    expect(report.documentScrolls).toBe(false);
    expect(report.listScrolls).toBe(true);
    expect(editFocus.focused).toBe(true); // edit form opens with the URL field focused
    expect(report.hasOnclick).toBe(false); // event handlers stripped
    expect(report.hasJsUrl).toBe(false); // javascript: URL stripped
    expect(report.imgLoading).toBe("lazy"); // applyEmbedHints: the old lazyHtml pass
    expect(report.hasLiteYoutube).toBe(true); // YouTube iframe → custom element
    expect(report.liteVideoId).toBe("dQw4w9WgXcQ");
    expect(report.liteDefined).toBe(true); // lite-youtube-embed imported (defines the element)
    expect(report.liteUpgraded).toBe(true); // …so the preview actually rendered
    expect(report.liteStyled).toBe(true); // …and its stylesheet loaded (poster visible)
    expect(report.comicCaption).toBe("Alt text: the comic joke"); // xkcd alt text rendered
    expect(report.comicImgTitle).toBe(null); // …and the tooltip dropped (MF parity)
    // A title is never markup: the tag stays text, no element appears, nothing runs.
    expect(report.titleText).toContain("<img src=x onerror=");
    expect(report.titleImg).toBe(false);
    expect(report.titleXss).toBe(false);
    expect(report.linkHref).toBe("https://example.com/relative"); // relative → absolute against feed base
    // fetch-error glyph: yellow ⚠️ (emoji presentation), never a bare/text ⚠ (renders red).
    expect(report.warnEmoji).toBe(true);
    expect(report.warnBare).toBe(false);
  } finally {
    await view.close();
  }
}, 30_000);

it("reading behaviours: windowing, auto-read on scroll, and click semantics", async () => {
  const view = new Bun.WebView({ width: 1100, height: 800 });
  try {
    await signIn(view);
    await openFeedView(view);

    const readState = (i: number): string =>
      `const a = document.querySelectorAll("article")[${i}]; return a && a.className.includes("bg-gray-100") ? "read" : "unread"`;

    // First window only (VIEW_PAGE_SIZE), and nothing is read before the user
    // has scrolled — visibility alone marks nothing (old auto-read.spec).
    const firstWindow = (await view.evaluate(
      until('const n = document.querySelectorAll("article").length; return n > 0 ? n : 0'),
    )) as number;
    console.log(
      "first window:",
      firstWindow,
      "| article 0:",
      await view.evaluate(`(() => { ${readState(0)} })()`),
    );
    expect(firstWindow).toBe(100);
    expect((await view.evaluate(`(() => { ${readState(0)} })()`)) as string).toBe("unread");

    // Scrolling to the sentinel pulls the next window (old pagination.spec).
    // Target the sentinel itself: the list's 100dvh bottom padding sits below
    // it, so jumping to scrollHeight overshoots the observer's rootMargin. Keep
    // nudging it into view — card heights shift as bodies land, so one computed
    // position sometimes leaves the sentinel just outside the margin.
    const scrolled = (await view.evaluate(`
        (async () => {
          const el = document.querySelector('[data-testid="entry-scroll"]')
          for (let i = 0; i < 20 && document.querySelectorAll('article').length <= 100; i++) {
            const s = document.getElementById('entry-sentinel')
            if (s) {
              const top = s.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
              el.scrollTop = top - el.clientHeight + 100
            }
            await new Promise((r) => setTimeout(r, 100))
          }
          return Math.round(el.scrollTop)
        })()
      `)) as number;
    const articles = (await view.evaluate(
      // More than the first window: the exact total depends on how many of the
      // fixture rows earlier tests left unread, so assert the paging, not 120.
      until('const n = document.querySelectorAll("article").length; return n > 100 ? n : 0'),
    )) as number;
    console.log("scrolled to sentinel:", scrolled, "| windowed articles:", articles);
    expect(articles).toBeGreaterThan(100);

    // Auto-read: entries the scroll carried above the band are read, the ones
    // still below it are not.
    await view.evaluate(
      `(() => { const el = document.querySelector('[data-testid="entry-scroll"]'); el.scrollTop = 2400; return el.scrollTop })()`,
    );
    const firstAfter = (await view.evaluate(
      until(`${readState(0)} === "read" ? "read" : ""`),
    )) as string;
    const farState = (await view.evaluate(`(() => { ${readState(115)} })()`)) as string;
    console.log("auto-read:", firstAfter, "| far entry:", farState);
    expect(firstAfter).toBe("read");
    expect(farState).toBe("unread");

    // Click semantics (restored): a link click marks read; a card-body click
    // only toggles the fold. Use entries the scroll left below the band.
    const unreadIds = (await view.evaluate(`
        (() => [...document.querySelectorAll('article')]
          .filter((a) => !a.className.includes('bg-gray-100'))
          .slice(-2)
          .map((a) => a.getAttribute('data-entry-id')))()
      `)) as string[];
    expect(unreadIds.length).toBe(2);
    const [linkId, cardId] = unreadIds as [string, string];

    await view.evaluate(
      `(() => { document.querySelector('[data-entry-id="${linkId}"] a').click(); return true })()`,
    );
    const linkRead = (await view.evaluate(
      until(
        `const a = document.querySelector('[data-entry-id="${linkId}"]'); return a && a.className.includes("bg-gray-100") ? "read" : ""`,
      ),
    )) as string;
    expect(linkRead).toBe("read");

    const cardState = (await view.evaluate(
      `(() => { const a = document.querySelector('[data-entry-id="${cardId}"]'); return a.className.includes('bg-gray-100') ? 'read' : 'unread' })()`,
    )) as string;
    console.log("link click ->", linkRead, "| card-body click state:", cardState);
    expect(cardState).toBe("unread");
  } finally {
    await view.close();
  }
}, 45_000);

it("URL shape survives the back button", async () => {
  const view = new Bun.WebView({ width: 1100, height: 800 });
  try {
    await signIn(view);
    await view.navigate(`${BASE}/`);

    const href = (await view.evaluate(`
        (() => {
          const a = [...document.querySelectorAll('a')].find((x) => (x.getAttribute('href') ?? '').includes('feed='))
          if (!a) return null
          a.click()
          return a.getAttribute('href')
        })()
      `)) as string | null;
    await view.evaluate(until('return location.search.includes("feed=") ? 1 : 0'));
    const afterClick = (await view.evaluate(`location.pathname + location.search`)) as string;

    await view.evaluate(`history.back()`);
    await view.evaluate(until('return location.search.includes("feed=") ? 0 : 1'));
    const afterBack = (await view.evaluate(`location.pathname + location.search`)) as string;
    console.log(
      "URL probe — link:",
      href,
      "| after click:",
      afterClick,
      "| after back:",
      afterBack,
    );
    expect(afterClick).toContain("feed=");
    expect(afterBack).toBe("/");
  } finally {
    await view.close();
  }
}, 45_000);

it("header names a feed the sidebar hides (everything read, unread-only view)", async () => {
  // Read every entry in the fixture: the feed now has nothing unread, so the
  // sidebar drops it — the header must still name it (it showed "Feed <uuid>").
  const handle = openDatabase(fixtureDbPath);
  const feedId = (handle.sqlite.query("SELECT id FROM feeds LIMIT 1").get() as { id: string }).id;
  handle.sqlite.run("UPDATE entries SET status = 'read'; UPDATE feeds SET parsing_error_count = 0");
  handle.sqlite.close();

  const view = new Bun.WebView({ width: 1100, height: 800 });
  try {
    await signIn(view);

    await view.navigate(`${BASE}/?feed=${feedId}`);
    // Wait for the CORRECT label (the id fallback renders first, so a
    // non-empty check would resolve instantly).
    const label = (await view.evaluate(
      until(
        `const t = document.querySelector('[data-testid="feed-menu-trigger"]'); const v = t ? t.textContent.trim() : ''; return v.startsWith('Blog') ? v : ''`,
        5000,
      ),
    )) as string;
    const finalLabel = (await view.evaluate(
      `(() => { const t = document.querySelector('[data-testid="feed-menu-trigger"]'); return t ? t.textContent.trim() : '' })()`,
    )) as string;
    // The sidebar keeps the view's own feed even with nothing unread in it —
    // the server is asked for the current feed for exactly this reason.
    const sidebarText = (await view.evaluate(
      `(() => { const p = document.querySelector('[data-testid="feed-panel"]'); return p ? p.textContent : '' })()`,
    )) as string;
    console.log("header label:", JSON.stringify(finalLabel), "| resolved:", JSON.stringify(label));
    expect(sidebarText).toContain("Blog");
    expect(finalLabel.startsWith("Blog")).toBe(true);
    expect(finalLabel.includes(feedId)).toBe(false);
  } finally {
    await view.close();
  }
}, 45_000);

it("home lists favorited feeds and nothing else", async () => {
  const view = new Bun.WebView({ width: 1100, height: 800 });
  try {
    // Earlier tests mark everything read, which hides the feed from the sidebar
    // (hideEmptyFeeds) and leaves nothing to click.
    restoreUnread();
    await signIn(view);

    // Home is links, not entries: no reading list, no Latest row.
    await view.navigate(`${BASE}/`);
    const home = (await view.evaluate(`
        (() => {
          const deadline = Date.now() + 5000
          return new Promise((resolve) => {
            const tick = () => {
              const panel = document.querySelector('[data-testid="feed-panel"]')
              const text = panel ? panel.textContent : ''
              if (text && text.includes('Blog')) return resolve({
                hasHome: !!document.querySelector('[data-testid="home"]'),
                noFavorites: !!document.querySelector('[data-testid="home-no-favorites"]'),
                links: document.querySelectorAll('[data-testid="home-favorite-link"]').length,
                entries: document.querySelectorAll('[data-entry-id]').length,
                hasLatest: text.includes('Latest'),
                hasStarred: text.includes('Starred'),
              })
              if (Date.now() > deadline) return resolve(null)
              setTimeout(tick, 50)
            }
            tick()
          })
        })()
      `)) as {
      hasHome: boolean;
      noFavorites: boolean;
      links: number;
      entries: number;
      hasLatest: boolean;
      hasStarred: boolean;
    } | null;
    console.log("home before favoriting:", JSON.stringify(home));
    expect(home).not.toBeNull();
    expect(home!.hasHome).toBe(true);
    expect(home!.noFavorites).toBe(true);
    expect(home!.links).toBe(0);
    expect(home!.entries).toBe(0); // a navigation page, not a reading surface
    expect(home!.hasLatest).toBe(false); // the old aggregate is gone
    expect(home!.hasStarred).toBe(true);

    // Favorite the feed from its own menu. Open the feed first and let it load:
    // the menu's per-feed rows depend on the view being the feed view.
    await openFeedView(view);
    await view.click('[data-testid="feed-menu-trigger"]');
    const menuText = (await view.evaluate(
      `(() => { const d = document.getElementById('feed-menu'); return d ? d.textContent : '' })()`,
    )) as string;
    expect(menuText).toContain("Favorite feed");
    await view.click('[data-testid=\"feed-menu-favorite\"]');
    await Bun.sleep(300);
    // The row has now flipped its own label, which is the confirmation.
    await view.click('[data-testid="feed-menu-trigger"]');
    const flipped = (await view.evaluate(
      `(() => { const d = document.getElementById('feed-menu'); return d ? d.textContent : '' })()`,
    )) as string;
    expect(flipped).toContain("Unfavorite feed");

    // Star sits immediately left of the unread count. Scope to the favorited
    // feed row: categories carry the same testid on their own count.
    const clusterOrder = (await view.evaluate(
      `(() => {
        const star = document.querySelector('[data-testid="feed-favorite"]')
        if (!star) return ''
        const cluster = star.parentElement
        return [...cluster.children]
          .map((child) => child.getAttribute('data-testid') || child.tagName)
          .join(',')
      })()`,
    )) as string;
    console.log("sidebar right-hand cluster:", clusterOrder);
    expect(clusterOrder).toContain("feed-favorite");
    expect(clusterOrder.indexOf("feed-favorite")).toBeLessThan(clusterOrder.indexOf("feed-count"));
    await view.press("Escape");

    // The link appears on the home page, and the feed stays in its category.
    await view.navigate(`${BASE}/`);
    const after = (await view.evaluate(`
        (() => {
          const deadline = Date.now() + 5000
          return new Promise((resolve) => {
            const tick = () => {
              const link = document.querySelector('[data-testid="home-favorite-link"]')
              if (link) return resolve({
                links: document.querySelectorAll('[data-testid="home-favorite-link"]').length,
                groups: document.querySelectorAll('[data-testid="home-category"]').length,
                category: (() => {
                  const group = link.closest('[data-testid="home-category"]')
                  const title = group?.querySelector('[data-testid="home-category-title"]')
                  return title ? title.textContent.trim() : ''
                })(),
                label: link.textContent.trim(),
                href: link.getAttribute('href'),
                starred: !!document.querySelector('[data-testid="feed-favorite"]'),
                count: (() => {
                  const c = link.querySelector('[data-testid="home-favorite-count"]')
                  return c ? Number(c.textContent.trim()) : null
                })(),
              })
              if (Date.now() > deadline) return resolve(null)
              setTimeout(tick, 50)
            }
            tick()
          })
        })()
      `)) as {
      links: number;
      groups: number;
      category: string;
      label: string;
      href: string;
      starred: boolean;
      count: number | null;
    } | null;
    console.log("home after favoriting:", JSON.stringify(after));
    expect(after).not.toBeNull();
    expect(after!.links).toBe(1);
    expect(after!.groups).toBe(1); // one heading, not one per link
    expect(after!.category).toBe("Tech"); // the favorite sits under its category
    expect(after!.label).toContain("Blog");
    expect(after!.href).toMatch(/^\/?\?feed=/);
    expect(after!.starred).toBe(true); // sidebar marks it too
    // The count rides along, so the home page answers "how much is waiting"
    // without opening the feed.
    expect(after!.count).toBe(120); // the fixture: 120 entries, every one unread

    // A favorite with nothing unread is NOT listed — but the page must not
    // claim there are no favorites either. It has to say the real reason.
    const handle = openDatabase(fixtureDbPath);
    handle.sqlite.run("UPDATE entries SET status = 'read'");
    handle.sqlite.close();
    await view.navigate(`${BASE}/`);
    const caughtUp = (await view.evaluate(
      until(
        `const m = document.querySelector('[data-testid="home-caught-up"]'); return m ? m.textContent.trim() : ''`,
      ),
    )) as string;
    const linksWhileRead = (await view.evaluate(
      `document.querySelectorAll('[data-testid="home-favorite-link"]').length`,
    )) as number;
    console.log("home with everything read:", JSON.stringify(caughtUp), "| links:", linksWhileRead);
    expect(caughtUp).toContain("Nothing unread");
    expect(linksWhileRead).toBe(0);

    // And unfavoriting returns it to the plain "no favorites" state. Everything
    // is read now, so open the feed directly: `openFeedView` waits for entries,
    // and the unread-only view has none.
    await view.navigate(`${BASE}/?feed=${fixtureFeedId()}`);
    await view.click('[data-testid="feed-menu-trigger"]');
    await view.click('[data-testid=\"feed-menu-favorite\"]');
    await Bun.sleep(300);
    await view.navigate(`${BASE}/`);
    const emptied = (await view.evaluate(
      until(
        `const m = document.querySelector('[data-testid="home-no-favorites"]'); return m ? m.textContent.trim() : ''`,
      ),
    )) as string;
    expect(emptied).toContain("No favorite feeds yet");
  } finally {
    await view.close();
  }
}, 45_000);

// Runs last: it expands an entry (which marks it read).
it("the comic rewrite leaves other domains alone", async () => {
  const view = new Bun.WebView({ width: 1100, height: 800 });
  try {
    await signIn(view);
    // The previous test marks everything read, and the default view is
    // unread-only: restore the list so there are cards to expand.
    const handle = openDatabase(fixtureDbPath);
    handle.sqlite.run("UPDATE entries SET status = 'unread'");
    handle.sqlite.close();
    await openFeedView(view);
    // Expand the entry whose image carries a title on a NON-comic URL.
    const clicked = (await view.evaluate(
      until(`
          const card = [...document.querySelectorAll('[data-entry-id]')].find(
            (c) => (c.querySelector('.msubject')?.textContent ?? '').trim() === 'Plain 50',
          )
          if (!card) return ''
          card.click()
          return card.getAttribute('aria-expanded') === 'true' ? 'expanded' : 'clicked'
        `),
    )) as string;
    console.log("plain-entry expansion:", clicked);
    const kept = (await view.evaluate(
      until(`return document.querySelector('img[title="Not a comic"]') ? 'kept' : ''`),
    )) as string;
    expect(kept).toBe("kept"); // the rule keys off the entry's domain, not the feed
  } finally {
    await view.close();
  }
}, 45_000);

// Runs last: it adds feeds (with one unread item each, so the sidebar shows
// them) to assert the rendered order.
it("the sidebar sorts feeds case-insensitively", async () => {
  const handle = openDatabase(fixtureDbPath);
  const now = epochMs(Date.now());
  for (const title of ["apple feed", "cherry feed", "Zebra feed"]) {
    const feedId = newFeedId(now);
    const slug = title.replace(/\s+/g, "-");
    handle.sqlite.run(
      "INSERT INTO feeds (id, user_id, category_id, title, feed_url, site_url, created_at) VALUES (?, (SELECT id FROM users LIMIT 1), (SELECT id FROM categories LIMIT 1), ?, ?, ?, ?)",
      [feedId, title, `https://example.com/${slug}`, `https://example.com/${slug}/`, now],
    );
    handle.sqlite.run(
      `INSERT INTO entries (id, user_id, feed_id, hash, title, content, published_at, created_at, changed_at)
         VALUES (?, (SELECT id FROM users LIMIT 1), ?, ?, ?, '<p>body</p>', ?, ?, ?)`,
      [newEntryId(now), feedId, `case-${slug}`, `${title} item`, now, now, now],
    );
  }
  handle.sqlite.close();

  const view = new Bun.WebView({ width: 1100, height: 800 });
  try {
    await signIn(view);
    await view.navigate(`${BASE}/`);
    const order = (await view.evaluate(
      until(`
          const els = [...document.querySelectorAll('a[href^="/?feed="] span')]
          return els.length >= 4 ? JSON.stringify(els.map((el) => el.textContent)) : ''
        `),
    )) as string;
    console.log("sidebar feed order:", order);
    // Binary collation would render ['Blog', 'Zebra feed', 'apple feed', 'cherry feed'].
    expect(JSON.parse(order)).toEqual(["apple feed", "Blog", "cherry feed", "Zebra feed"]);
  } finally {
    await view.close();
  }
}, 45_000);

// Pins a decision, not just behaviour: "mark all read" marks exactly the ids the
// view fetched (the loaded window), never a server-side re-lookup of candidates.
// A bulk implementation would mark all 100+ and fail this.
it("mark all read marks exactly the displayed window", async () => {
  const reset = openDatabase(fixtureDbPath);
  reset.sqlite.run("UPDATE entries SET status = 'unread'");
  const total = (reset.sqlite.query("SELECT count(*) AS n FROM entries").get() as { n: number }).n;
  reset.sqlite.close();

  const counts = () => {
    const handle = openDatabase(fixtureDbPath);
    const rows = handle.sqlite
      .query("SELECT status, count(*) AS n FROM entries GROUP BY status")
      .all() as Array<{
      status: string;
      n: number;
    }>;
    handle.sqlite.close();
    return Object.fromEntries(rows.map((row) => [row.status, row.n])) as Record<string, number>;
  };

  const view = new Bun.WebView({ width: 1100, height: 800 });
  try {
    await signIn(view);
    await openFeedView(view);
    await view.evaluate(
      until(`return document.querySelectorAll('[data-entry-id]').length >= 100 ? 'ready' : ''`),
    );
    await view.evaluate(
      `(() => { document.querySelector('button[aria-label="Mark all read"]').click(); return true })()`,
    );
    let seen: Record<string, number> = {};
    for (let i = 0; i < 50; i++) {
      seen = counts();
      if ((seen.read ?? 0) >= 100) break;
      await Bun.sleep(100);
    }
    console.log("statuses after mark-all:", JSON.stringify(seen), "| total:", total);
    expect(seen.read).toBe(100); // the loaded window only (VIEW_PAGE_SIZE)
    expect(seen.unread).toBe(total - 100); // everything past it stays unread
  } finally {
    await view.close();
  }
}, 45_000);

// The View row used to derive the next mode from the raw override, which is null
// until a pref is saved: the first click set 'expanded' when 'expanded' was
// already in effect. Its label was always "expanded" because of a dead
// `(!x && true)` clause. Both the row and the `v` key now resolve the effective mode.
it("the View toggle flips on the first click, and reads truthfully", async () => {
  const view = new Bun.WebView({ width: 1100, height: 800 });
  // The row lives in the (closed) feed menu, whose content is in the DOM and
  // reactive, so its label is readable without opening the dialog. Poll for the
  // expected value: the click's re-render lands a tick later.
  const waitForLabel = (expected: string) =>
    until(`
      const row = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('View:'))
      const text = row ? row.textContent.trim() : ''
      return text === ${JSON.stringify(expected)} ? text : ''
    `);
  const clickView = `(() => {
      [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('View:'))?.click()
      return true
    })()`;
  try {
    await signIn(view);
    await view.navigate(`${BASE}/`);

    const before = (await view.evaluate(waitForLabel("View: expanded"))) as string;
    await view.evaluate(clickView); // first click: must flip
    const afterFirstClick = (await view.evaluate(waitForLabel("View: list"))) as string;

    console.log("view label:", JSON.stringify([before, afterFirstClick]));
    expect(before).toBe("View: expanded"); // the default, and the label must say so
    expect(afterFirstClick).toBe("View: list"); // the dead first click would read 'expanded'
    // The `v` key is not asserted here: the menu row unmounts with its dialog,
    // so reading it back after a keypress is racy. Both sites now call the same
    // effectiveViewMode() helper, so the click path covers the logic.
  } finally {
    await view.close();
  }
}, 45_000);

/**
 * Faults a page raised on its own: uncaught errors, unhandled rejections, and the
 * diagnostics Solid escalates to errors. Installed *after* the page settles,
 * because a fault during load is the load assertion's business.
 */
const watchForFaults = async (view: Bun.WebView): Promise<void> => {
  await view.evaluate(`
    (() => {
      window.__faults = []
      window.addEventListener('error', (e) =>
        window.__faults.push('error: ' + ((e.error && e.error.stack) || e.message)))
      window.addEventListener('unhandledrejection', (e) =>
        window.__faults.push('rejection: ' + ((e.reason && e.reason.stack) || String(e.reason))))
      return true
    })()
  `);
};

const faults = async (view: Bun.WebView): Promise<string[]> =>
  JSON.parse((await view.evaluate("JSON.stringify(window.__faults || [])")) as string) as string[];

it("clicking through feeds keeps working: navigation is not a one-shot", async () => {
  // The regression this exists for: the reading surface halted the reactive
  // system on the home page, so the *first* click navigated and every later one
  // was silently dropped. Every other test here reloads the document per test,
  // which hides that class of bug completely — a halted app still renders.
  const view = new Bun.WebView({ width: 1100, height: 800 });
  try {
    await signIn(view);
    await view.navigate(`${BASE}/`);
    await view.evaluate(until('return document.querySelectorAll(".app-sidebar a").length > 2 ? 1 : 0'));
    await watchForFaults(view);

    const visited: string[] = [];
    // By href, not by position: the sidebar also carries section links (Home,
    // Starred), which have no entries of their own to land in.
    const feedLinks = (await view.evaluate(
      `[...document.querySelectorAll('.app-sidebar a')].map((a) => a.getAttribute('href') || '').filter((href) => href.includes('feed=')).slice(0, 3)`,
    )) as string[];
    expect(feedLinks.length).toBe(3);

    for (const target of feedLinks) {
      await view.evaluate(
        `[...document.querySelectorAll('.app-sidebar a')].find((a) => a.getAttribute('href') === ${JSON.stringify(target)}).click()`,
      );
      const landed = (await view.evaluate(
        until(
          `const want = ${JSON.stringify(target)}; return location.pathname + location.search === want ? want : ''`,
          10_000,
        ),
      )) as string;
      // The URL follows the click, and the click was not a full page load.
      expect(landed).toBe(target);
      visited.push(landed);

      // …and the view it landed on has entries, i.e. the projection re-read.
      const rows = (await view.evaluate(
        until('const n = document.querySelectorAll("[data-entry-id]").length; return n > 0 ? n : 0'),
      )) as number;
      expect(rows).toBeGreaterThan(0);
    }

    // Different feeds, not the same one three times.
    expect(new Set(visited).size).toBe(visited.length);
    expect(await faults(view)).toEqual([]);
  } finally {
    await view.close();
  }
}, 60_000);


it("one view costs one round trip of server calls, not one per row", async () => {
  // The regression this exists for: entry bodies used to be fetched per card, so
  // opening a feed fired ~100 requests to paint one screen. Every other test in
  // this file passed while that was true — the screen was correct, just expensive.
  const view = new Bun.WebView({ width: 1100, height: 800 });
  try {
    await signIn(view);
    await view.navigate(`${BASE}/`);
    await view.evaluate(
      until('return document.querySelectorAll(".app-sidebar a").length > 3 ? 1 : 0', 30_000),
    );

    const feedHref = (await view.evaluate(
      `[...document.querySelectorAll('.app-sidebar a')].map((a) => a.getAttribute('href') || '').find((href) => href.includes('feed=')) || ''`,
    )) as string;
    expect(feedHref).not.toBe('');

    const report = (await view.evaluate(`
      (async () => {
        performance.clearResourceTimings()
        const link = [...document.querySelectorAll('.app-sidebar a')]
          .find((a) => a.getAttribute('href') === ${JSON.stringify(feedHref)})
        link.click()
        const deadline = Date.now() + 15000
        while (Date.now() < deadline) {
          if (document.querySelectorAll('article').length > 0) break
          await new Promise((r) => setTimeout(r, 50))
        }
        await new Promise((r) => setTimeout(r, 500))
        const calls = performance.getEntriesByType('resource')
          .filter((e) => e.name.includes('/_server'))
          .map((e) => e.name.split('/_server/data/')[1]?.split('-')[0] || e.name)
        return JSON.stringify({ rows: document.querySelectorAll('article').length, calls })
      })()
    `)) as string;
    const { rows, calls } = JSON.parse(report) as { rows: number; calls: string[] };

    console.log("server calls for one feed view:", calls);
    expect(rows).toBeGreaterThan(0);
    // The view's entries and the sidebar: two reads, plus slack for one more.
    expect(calls.length).toBeLessThanOrEqual(3);
    // Nothing may be fetched per row.
    expect(calls).not.toContain('content');
  } finally {
    await view.close();
  }
}, 60_000);

it("a reading session raises no page faults", async () => {
  // Reads, auto-read on scroll, and a star: the writes that go through the
  // optimistic path. A rejected write is expected to be *reported* in the UI, not
  // to escape as an uncaught error.
  const view = new Bun.WebView({ width: 1100, height: 800 });
  try {
    await signIn(view);
    await openFeedView(view);
    await watchForFaults(view);

    await view.evaluate(`
      (() => {
        const el = document.querySelector('[data-testid="entry-scroll"]')
        el.scrollTop = 2400
        return el.scrollTop
      })()
    `);
    const read = (await view.evaluate(
      until(
        `const n = [...document.querySelectorAll('[data-entry-id]')].filter((a) => a.className.includes('bg-gray-100')).length; return n > 0 ? n : 0`,
      ),
    )) as number;
    expect(read).toBeGreaterThan(0);
  } finally {
    await view.close();
  }
}, 60_000);

it("prev/next move relative to the card in view, without waiting on a write", async () => {
  // Two regressions here, both from the button path:
  //  - the anchor came from an IntersectionObserver that was rooted at the
  //    viewport (so it never fired) and the buttons indexed from -1, which sent a
  //    scrolled-down reader back to the top of the list;
  //  - the scroll ran in an effect whose flush can be deferred behind the
  //    mark-read write, so the view moved only after the server answered.
  const view = new Bun.WebView({ width: 1100, height: 800 });
  try {
    await signIn(view);
    // Shared fixture: earlier tests read everything and may leave hide-read on, so
    // start from a known list rather than from whatever they left behind.
    restoreUnread();
    await openFeedView(view);
    const cards = (await view.evaluate(
      until('const n = document.querySelectorAll("[data-entry-id]").length; return n > 5 ? n : 0'),
    )) as number;
    expect(cards).toBeGreaterThan(5);

    // The same band the app uses: the first card reaching the top 15% of the list.
    const anchor = `(() => {
      const el = document.querySelector('[data-testid="entry-scroll"]')
      const cards = [...document.querySelectorAll('[data-entry-id]')]
      const bandTop = el.getBoundingClientRect().top + el.clientHeight * 0.15
      const index = cards.findIndex((c) => c.getBoundingClientRect().bottom > bandTop)
      return JSON.stringify({ index, top: Math.round(el.scrollTop) })
    })()`;
    const at = async () => JSON.parse((await view.evaluate(anchor)) as string) as { index: number; top: number };

    // Start well down the list, the way a reader arrives after scrolling by hand.
    await view.evaluate(`
      (() => {
        const el = document.querySelector('[data-testid="entry-scroll"]')
        const card = document.querySelectorAll('[data-entry-id]')[4]
        el.scrollTop = el.scrollTop + (card.getBoundingClientRect().top - el.getBoundingClientRect().top)
        return el.scrollTop
      })()
    `);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const before = await at();

    await view.click('[aria-label="Next entry (j)"]');
    // Short wait on purpose: a scroll that waits for the write takes longer.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const next = await at();
    expect(next.index).toBe(before.index + 1);
    expect(next.top).toBeGreaterThan(before.top);

    await view.click('[aria-label="Next entry (j)"]');
    await new Promise((resolve) => setTimeout(resolve, 150));
    const twice = await at();
    expect(twice.index).toBe(before.index + 2);

    await view.click('[aria-label="Previous entry (k)"]');
    await new Promise((resolve) => setTimeout(resolve, 150));
    const back = await at();
    expect(back.index).toBe(before.index + 1);
  } finally {
    await view.close();
  }
}, 60_000);

it("the reading pane keeps its position across a reload", async () => {
  // The pane is an inner scroller and the document never scrolls, so the
  // browser restores nothing after a reload (and Android WebView has the same
  // failure for a bfcache resume). lib/scroll-memory keeps its own anchor.
  const view = new Bun.WebView({ width: 420, height: 800 });
  try {
    await signIn(view);
    restoreUnread();
    // The list must survive the reload unchanged: the default view hides read
    // items, and the rows auto-read on the way down would be filtered out of a
    // reloaded window, taking the anchor entry with them (the pixel fallback is
    // what handles that). Show read rows so the anchor is still there.
    const prefs = openDatabase(fixtureDbPath);
    const feed = prefs.sqlite.query("SELECT id, user_id FROM feeds LIMIT 1").get() as {
      id: string;
      user_id: string;
    };
    prefs.sqlite.run(
      "INSERT INTO user_prefs (user_id, scope, prefs) VALUES (?, ?, ?) ON CONFLICT (user_id, scope) DO UPDATE SET prefs = excluded.prefs",
      [feed.user_id, `feed:${feed.id}`, JSON.stringify({ hideReadItems: false })],
    );
    prefs.sqlite.close();
    await openFeedView(view);

    const at = `(() => {
      const el = document.querySelector('[data-testid="entry-scroll"]')
      const cards = [...document.querySelectorAll('[data-entry-id]')]
      const bandTop = el.getBoundingClientRect().top + el.clientHeight * 0.15
      const index = cards.findIndex((c) => c.getBoundingClientRect().bottom > bandTop)
      return JSON.stringify({ index, top: Math.round(el.scrollTop) })
    })()`;

    // Start well down the list, the way the reader arrives after scrolling.
    await view.evaluate(`
      (() => {
        const el = document.querySelector('[data-testid="entry-scroll"]')
        const card = document.querySelectorAll('[data-entry-id]')[4]
        el.scrollTop = el.scrollTop + (card.getBoundingClientRect().top - el.getBoundingClientRect().top)
        return el.scrollTop
      })()
    `);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const before = JSON.parse((await view.evaluate(at)) as string) as { index: number; top: number };
    expect(before.index).toBeGreaterThan(0);
    expect(before.top).toBeGreaterThan(0);

    await view.reload();
    // Wait for the saved position to be re-applied (it lands after hydration).
    const restored = (await view.evaluate(
      until(`const el = document.querySelector('[data-testid="entry-scroll"]')
        return el && el.scrollTop > 0 ? el.scrollTop : 0`),
    )) as number;
    expect(restored).toBeGreaterThan(0);

    const after = JSON.parse((await view.evaluate(at)) as string) as { index: number; top: number };
    expect(after.index).toBe(before.index);
    expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(4);
  } finally {
    await view.close();
  }
}, 60_000);

it("saves the scroll position without waiting for pagehide", async () => {
  // Android can freeze or kill a tab without firing pagehide. A debounced save
  // while scrolling, plus the Page Lifecycle freeze event, keeps a position
  // available for the next document load.
  restoreUnread();
  const prefs = openDatabase(fixtureDbPath);
  const feed = prefs.sqlite.query("SELECT id, user_id FROM feeds LIMIT 1").get() as {
    id: string;
    user_id: string;
  };
  prefs.sqlite.run(
    "INSERT INTO user_prefs (user_id, scope, prefs) VALUES (?, ?, ?) ON CONFLICT (user_id, scope) DO UPDATE SET prefs = excluded.prefs",
    [feed.user_id, `feed:${feed.id}`, JSON.stringify({ hideReadItems: false, sort: "oldest" })],
  );
  prefs.sqlite.close();

  const view = new Bun.WebView({ width: 1100, height: 800 });
  try {
    await signIn(view);
    const feedId = fixtureFeedId();
    await openFeedView(view, feedId);
    await view.evaluate(`
      (() => {
        const el = document.querySelector('[data-testid="entry-scroll"]')
        const card = document.querySelectorAll('[data-entry-id]')[6]
        el.scrollTop = el.scrollTop + (card.getBoundingClientRect().top - el.getBoundingClientRect().top)
        return el.scrollTop
      })()
    `);

    const raw = (await view.evaluate(
      until("return sessionStorage.getItem('mf-scroll:2')", 3000),
    )) as string | null;
    expect(raw).not.toBeNull();
    const saved = JSON.parse(raw!) as { view: string; anchor: string; offset: number };
    expect(saved.view).toContain(feedId);
    expect(saved.anchor).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isInteger(saved.offset)).toBe(true);

    // The freeze event saves immediately; it does not wait for the debounce.
    await view.evaluate(
      "(() => { sessionStorage.removeItem('mf-scroll:2'); document.dispatchEvent(new Event('freeze')); return true })()",
    );
    const frozen = JSON.parse(
      (await view.evaluate("sessionStorage.getItem('mf-scroll:2')")) as string,
    ) as { anchor: string };
    expect(frozen.anchor).toBe(saved.anchor);
  } finally {
    await view.close();
  }
}, 60_000);

it("restores an anchor that sits beyond the first window", async () => {
  // New entries arrive at the top while the tab is away, so the saved anchor
  // can be past the first page. Restore must page until the id is present, not
  // assume the old row count still reaches it.
  restoreUnread();
  const prefs = openDatabase(fixtureDbPath);
  const feed = prefs.sqlite.query("SELECT id, user_id FROM feeds LIMIT 1").get() as {
    id: string;
    user_id: string;
  };
  prefs.sqlite.run(
    "INSERT INTO user_prefs (user_id, scope, prefs) VALUES (?, ?, ?) ON CONFLICT (user_id, scope) DO UPDATE SET prefs = excluded.prefs",
    [feed.user_id, `feed:${feed.id}`, JSON.stringify({ hideReadItems: false, sort: "oldest" })],
  );
  prefs.sqlite.close();

  const view = new Bun.WebView({ width: 1100, height: 800 });
  try {
    await signIn(view);
    await openFeedView(view);

    // Pull the second page, then park the first card of that page at the top.
    await view.evaluate(`
      (() => {
        const el = document.querySelector('[data-testid="entry-scroll"]')
        el.scrollTop = el.scrollHeight
        return el.scrollTop
      })()
    `);
    await view.evaluate(until('return document.querySelectorAll("[data-entry-id]").length >= 110'));
    const anchorId = (await view.evaluate(`
      (() => {
        const el = document.querySelector('[data-testid="entry-scroll"]')
        const cards = document.querySelectorAll('[data-entry-id]')
        const card = cards[cards.length - 1]
        el.scrollTop = el.scrollTop + (card.getBoundingClientRect().top - el.getBoundingClientRect().top)
        return card.dataset.entryId
      })()
    `)) as string;

    await new Promise((resolve) => setTimeout(resolve, 400));
    await view.reload();
    const restored = (await view.evaluate(
      until(`const el = document.querySelector('[data-testid="entry-scroll"]')
        const anchor = document.getElementById('entry-${anchorId}')
        if (!el || !anchor || el.scrollTop === 0) return 0
        return Math.abs(anchor.getBoundingClientRect().top - el.getBoundingClientRect().top) < 8 ? 1 : 0`, 15_000),
    )) as number;
    expect(restored).toBe(1);
    expect((await view.evaluate('document.querySelectorAll("[data-entry-id]").length')) as number).toBeGreaterThan(100);
  } finally {
    await view.close();
  }
}, 60_000);

it("a reload from a stale cached document cannot resurrect read entries", async () => {
  // The reported failure: after reading, a discarded tab reloads from a cache
  // that was allowed to store the document. The SSR payload still says every
  // entry is unread; the panel poll then updates the counter, so the list and
  // the sidebar disagree. The cache proxy replays a document only when its
  // headers permit storage; `private, no-cache` makes the reload revalidate.
  restoreUnread();
  const prefs = openDatabase(fixtureDbPath);
  const feed = prefs.sqlite.query("SELECT id, user_id FROM feeds LIMIT 1").get() as {
    id: string;
    user_id: string;
  };
  prefs.sqlite.run(
    "INSERT INTO user_prefs (user_id, scope, prefs) VALUES (?, ?, ?) ON CONFLICT (user_id, scope) DO UPDATE SET prefs = excluded.prefs",
    [feed.user_id, `feed:${feed.id}`, JSON.stringify({ hideReadItems: false })],
  );
  prefs.sqlite.close();

  const proxy = startCacheProxy(BASE);
  const view = new Bun.WebView({ width: 1100, height: 800 });
  try {
    await signIn(view, proxy.base);
    const feedId = fixtureFeedId();
    await openFeedView(view, feedId, proxy.base);
    await view.evaluate(until('return document.querySelectorAll("[data-entry-id]").length >= 10'));

    // Read a batch the way a scroll does, leaving the cached document stale.
    await view.evaluate(`
      (() => {
        const el = document.querySelector('[data-testid="entry-scroll"]')
        el.scrollTop = 2400
        return el.scrollTop
      })()
    `);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const db = openDatabase(fixtureDbPath);
    const read = db.sqlite
      .query("SELECT id FROM entries WHERE feed_id = ? AND status = 'read' ORDER BY published_at LIMIT 1")
      .get(feedId) as { id: string } | null;
    const unread = (
      db.sqlite.query("SELECT count(*) AS n FROM entries WHERE feed_id = ? AND status = 'unread'").get(feedId) as {
        n: number;
      }
    ).n;
    db.sqlite.close();
    expect(read).not.toBeNull();

    proxy.reset();
    // A discarded tab may never fire pagehide. Model that worst case: no saved
    // scroll position, so no scroll-driven auto-read paints over the stale rows.
    await view.evaluate(
      '(() => { sessionStorage.clear(); Storage.prototype.setItem = function(){}; return true })()',
    );
    await view.reload();
    await view.evaluate(until('return document.querySelectorAll("[data-entry-id]").length >= 10'));

    const restoredClass = (await view.evaluate(`
      (() => {
        const el = document.getElementById('entry-${read!.id}')
        return el ? el.className : null
      })()
    `)) as string | null;
    // The row the server knows is read must render read on the reloaded
    // document, not wait for an idle refresh or a scroll to correct it.
    expect(restoredClass).toContain("bg-gray-100");

    // Force the panel read the way the idle poll does. The list must already
    // agree with it; this is where the counter used to show the true number
    // while the list kept saying "unread".
    await view.click(`[data-testid="feed-panel"] a[href="/?feed=${feedId}"]`);
    const count = (await view.evaluate(
      until(`const a = document.querySelector('[data-testid="feed-panel"] a[href="/?feed=${feedId}"]')
        const row = a && a.closest('li')
        const c = row && row.querySelector('[data-testid="feed-count"]')
        return c && c.textContent === '${unread}' ? c.textContent : 0`),
    )) as string | number;
    expect(String(count)).toBe(String(unread));

    // The proxy must not have replayed the stale document at all.
    expect(proxy.hits()).toBe(0);
  } finally {
    await view.close();
    proxy.stop();
  }
}, 60_000);

it("a mark-read is painted while the next page is still loading", async () => {
  // The list's derive used to fetch the next page itself, and an async derive
  // holds the frame it runs in: while scrolling triggered a page read, a
  // mark-read made in the same frame stayed un-grey for the whole round trip.
  // Pages are now fetched ahead of the derive, so the paint never waits on them.
  const view = new Bun.WebView({ width: 1100, height: 800 });
  try {
    await signIn(view);
    restoreUnread();
    await openFeedView(view);
    await view.evaluate(until('return document.querySelectorAll("[data-entry-id]").length >= 90'));

    const report = (await view.evaluate(`(async () => {
      const el = document.querySelector('[data-testid="entry-scroll"]')
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const band = () => el.getBoundingClientRect().top + el.clientHeight * 0.15
      const unread = (c) => !c.className.includes('bg-gray-100')

      let pagePending = 0
      const realFetch = window.fetch
      window.fetch = async (...args) => {
        const [url, init] = args
        const body = typeof init?.body === 'string' ? init.body : ''
        const isPage = String(url).includes('viewEntries')
        if (isPage) pagePending++
        if (isPage) await sleep(800)
        try { return await realFetch(...args) } finally { if (isPage) pagePending-- }
      }

      el.scrollTop = 600
      await sleep(400)

      // Ask for the next page (the sentinel), then come back before it lands.
      const sentinel = document.getElementById('entry-sentinel')
      const sentinelTop = sentinel.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
      el.scrollTop = sentinelTop - el.clientHeight + 100
      await sleep(80)
      const inFlight = pagePending
      el.scrollTop = 400
      await sleep(80)

      let node = null
      for (const c of document.querySelectorAll('[data-entry-id]')) {
        if (unread(c) && c.getBoundingClientRect().top > band() + 80) { node = c; break }
      }
      if (!node) return { error: 'no unread card below the band' }

      let changed = null
      const obs = new MutationObserver(() => {
        if (changed === null && !unread(node)) changed = Math.round(performance.now() - t0)
      })
      obs.observe(node, { attributes: true, attributeFilter: ['class'] })
      const t0 = performance.now()
      el.scrollTop = el.scrollTop + (node.getBoundingClientRect().top - band() + 10)
      await sleep(400)
      obs.disconnect()
      return { inFlight, latencyMs: changed, pendingWhenSettled: pagePending, endedRead: !unread(node) }
    })()`)) as Record<string, unknown>;
    console.log("optimistic mark during paging:", JSON.stringify(report));

    expect(report.inFlight).toBeGreaterThan(0);
    expect(report.endedRead).toBe(true);
    // Well inside the 800ms page read: this is the paint, not the round trip.
    expect(report.latencyMs).toBeLessThan(250);
  } finally {
    await view.close();
  }
}, 60_000);

it("the counter follows the card, before the server answers", async () => {
  // The card and the sidebar are both optimistic guesses inside the mark action.
  // The sidebar's guess is confirmed by `refresh(panel)` landing in the same
  // transaction, so the number must move at once and must never bounce back.
  const view = new Bun.WebView({ width: 1100, height: 800 });
  try {
    await signIn(view);
    restoreUnread();
    await openFeedView(view);
    await view.evaluate(until('return document.querySelectorAll("[data-entry-id]").length >= 90'));

    const report = (await view.evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const unread = (c) => !c.className.includes('bg-gray-100')
      // The fixture feed's row: the sidebar holds feeds added by other tests.
      const feedCount = () => {
        for (const li of document.querySelectorAll('li')) {
          const link = li.querySelector(':scope > a')
          if (link && link.textContent.trim() === 'Blog') {
            return Number(li.querySelector('[data-testid="feed-count"]')?.textContent ?? '0')
          }
        }
        return -1
      }

      let writes = 0
      let slow = 0
      const realFetch = window.fetch
      window.fetch = async (...args) => {
        if (String(args[0]).includes('markRead') || String(args[0]).includes('markUnread')) {
          writes++
          if (slow) await sleep(slow)
        }
        return realFetch(...args)
      }
      const waitFor = async (predicate, timeout = 2000) => {
        const start = performance.now()
        while (performance.now() - start < timeout) {
          if (predicate()) return Math.round(performance.now() - start)
          await sleep(20)
        }
        return null
      }

      // Mark one card read, with the write deliberately slow.
      const card = [...document.querySelectorAll('[data-entry-id]')].find(unread)
      if (!card) return { error: 'no unread card' }
      const before = feedCount()
      const seen = []
      const obs = new MutationObserver(() => seen.push(unread(card) ? 'unread' : 'read'))
      obs.observe(card, { attributes: true, attributeFilter: ['class'] })

      slow = 600
      card.querySelector('button[aria-label="Mark read"]').click()
      const cardMs = await waitFor(() => !unread(card))
      const counterMs = await waitFor(() => feedCount() === before - 1)
      await sleep(900)
      const settled = feedCount()
      obs.disconnect()

      // Now the other direction: unread increments, again slowly.
      const back = feedCount()
      slow = 600
      card.querySelector('button[aria-label="Mark unread"]').click()
      const backCounterMs = await waitFor(() => feedCount() === back + 1)
      const backCardMs = await waitFor(() => unread(card))
      await sleep(900)

      return {
        before, cardMs, counterMs, backCounterMs, backCardMs,
        settled, final: feedCount(), writes,
        cardTransitions: seen,
      }
    })()`)) as Record<string, unknown>;
    console.log("optimistic counter:", JSON.stringify(report));

    expect(report.cardMs).not.toBeNull();
    expect(report.counterMs).not.toBeNull();
    expect(report.cardMs as number).toBeLessThan(250);
    expect(report.counterMs as number).toBeLessThan(250);
    expect(report.settled).toBe((report.before as number) - 1);
    expect(report.final).toBe(report.before);
    expect(report.backCardMs as number).toBeLessThan(250);
    expect(report.backCounterMs as number).toBeLessThan(250);
    // The card went read and stayed read: no revert-and-repaint at the settle.
    expect(report.cardTransitions).toEqual(["read"]);
  } finally {
    await view.close();
  }
}, 60_000);

it("a rejected mark-read puts the row and the counter back", async () => {
  // Both the card and the sidebar are optimistic guesses. The framework owns
  // them now, so a rejection reverts both without a manual rollback.
  const view = new Bun.WebView({ width: 1100, height: 800 });
  try {
    await signIn(view);
    restoreUnread();
    await openFeedView(view);
    await view.evaluate(until('return document.querySelectorAll("[data-entry-id]").length >= 90'));

    const report = (await view.evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const unread = (c) => !c.className.includes('bg-gray-100')
      // The fixture feed's row: the sidebar holds feeds added by other tests.
      const feedCount = () => {
        for (const li of document.querySelectorAll('li')) {
          const link = li.querySelector(':scope > a')
          if (link && link.textContent.trim() === 'Blog') {
            return Number(li.querySelector('[data-testid="feed-count"]')?.textContent ?? '0')
          }
        }
        return -1
      }
      const waitFor = async (predicate, timeout = 3000) => {
        const start = performance.now()
        while (performance.now() - start < timeout) {
          if (predicate()) return true
          await sleep(25)
        }
        return false
      }

      const realFetch = window.fetch
      window.fetch = (...args) => {
        if (String(args[0]).includes('markRead') || String(args[0]).includes('markUnread')) {
          return Promise.resolve(new Response('nope', { status: 500 }))
        }
        return realFetch(...args)
      }

      const card = [...document.querySelectorAll('[data-entry-id]')].find(unread)
      if (!card) return { error: 'no unread card' }
      const before = feedCount()

      let becameRead = false
      const obs = new MutationObserver(() => { if (!unread(card)) becameRead = true })
      obs.observe(card, { attributes: true, attributeFilter: ['class'] })
      card.querySelector('button[aria-label="Mark read"]').click()

      const reverted = await waitFor(() => becameRead && unread(card))
      const counterReverted = await waitFor(() => feedCount() === before)
      obs.disconnect()
      const banner = document.querySelector('[data-testid="write-error"]')
      const message = banner ? banner.textContent : null
      banner?.querySelector('button')?.click()
      return { becameRead, reverted, counterReverted, message, before, after: feedCount() }
    })()`)) as Record<string, unknown>;
    console.log("rejected mark-read:", JSON.stringify(report));

    expect(report.becameRead).toBe(true);
    expect(report.reverted).toBe(true);
    expect(report.counterReverted).toBe(true);
    expect(report.after).toBe(report.before);
    expect(String(report.message)).toContain("Could not mark that read");
  } finally {
    await view.close();
  }
}, 60_000);
