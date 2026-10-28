import { For, Show, createMemo } from "solid-js";

import type { CategoryId } from '../shared/ids'
import type { FeedInfo } from '../shared/types'
import { compareTitlesCI } from '../shared/util'
import { useReader } from '../lib/reader-context'
import { FeedIcon } from "./FeedIcon";

/**
 * The home page: links to your favorite feeds that have something unread,
 * grouped under their category. It is a navigation aid, not a reading surface —
 * no entries, no ordering beyond alphabetical.
 *
 * A favorite with nothing unread is left out (it is not going to be read), and
 * so is a category with no unread favorites left in it, but the page says so
 * rather than claiming you have no favorites at all. Favoriting happens from
 * the feed menu (`⋮`); a favorited feed keeps living in its category, unchanged.
 */
export const Home = () => {
  const r = useReader()
  const { favoriteFeeds, favoriteFeedsWithUnread } = r
  const unread = () => favoriteFeedsWithUnread();
  const anyFavorites = () => favoriteFeeds().length > 0;

  /** Unread favorites bucketed by category, categories in alphabetical order. */
  const groups = createMemo(() => {
    const titles = new Map(r.panel.categories.map((category) => [category.id, category.title]))
    const byCategory = new Map<CategoryId, { id: CategoryId; title: string; feeds: FeedInfo[] }>()
    for (const feed of unread()) {
      const group = byCategory.get(feed.categoryId) ?? {
        id: feed.categoryId,
        title: titles.get(feed.categoryId) ?? 'Uncategorized',
        feeds: [],
      }
      group.feeds.push(feed)
      byCategory.set(feed.categoryId, group)
    }
    return [...byCategory.values()].sort((a, b) => compareTitlesCI(a.title, b.title))
  })

  return (
    // A capped width keeps each title and its count one glance apart. Stretched
    // across a wide window the count drifts to the far edge and reads as absent.
    <section class="px-2 py-4 max-w-xl" data-testid="home">
      <h1 class="font-semibold text-lg mb-3">Favorites</h1>
      <Show
        when={unread().length > 0}
        fallback={
          <Show
            when={anyFavorites()}
            fallback={
              <p class="text-sm text-gray-500" data-testid="home-no-favorites">
                No favorite feeds yet. Open a feed, then use &#8942; &rarr; Favorite feed.
              </p>
            }
          >
            <p class="text-sm text-gray-500" data-testid="home-caught-up">
              Nothing unread in your favorite feeds.
            </p>
          </Show>
        }
      >
        <div class="flex flex-col gap-4" data-testid="home-favorites">
          <For each={groups()}>
            {(group) => (
              <section data-testid="home-category">
                <h2
                  data-testid="home-category-title"
                  class="px-2 mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500"
                >
                  {group.title}
                </h2>
                <ul class="flex flex-col gap-y-1">
                  <For each={group.feeds}>
                    {(feed) => (
                      <li>
                        <a
                          href={`/?feed=${feed.id}`}
                          data-testid="home-favorite-link"
                          class="flex items-center gap-x-2 px-2 py-1.5 rounded hover:bg-gray-100 text-sm"
                        >
                          <FeedIcon feedId={feed.id} title={feed.title} />
                          {/* Icon is centred against the text; the count shares the
                              name's baseline rather than being centred on it (a 12px
                              number centred on a 14px line sits visibly high). */}
                          <span class="min-w-0 flex items-baseline gap-x-2">
                            <span class="truncate">{feed.title}</span>
                            <span
                              data-testid="home-favorite-count"
                              class="shrink-0 text-xs text-gray-500 tabular-nums"
                            >
                              {r.counterFor(feed.id)}
                            </span>
                          </span>
                        </a>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            )}
          </For>
        </div>
      </Show>
    </section>
  );
};

export default Home;
