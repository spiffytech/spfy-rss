import { For, Show, createEffect, createMemo, createSignal, untrack } from 'solid-js'
import { useNavigate } from '@solidjs/router'

import type { FeedSaveError, FeedSaveResult } from '../shared/types'
import { compareTitlesCI } from '../shared/util'
import * as api from '../server/actions'
import { useReader } from '../lib/reader-context'

const NEW_FOLDER = '__new__'

const errorText = (result: Extract<FeedSaveResult, { ok: false }>): string => {
  const reasons: Record<FeedSaveError, string> = {
    invalid_url: 'Enter a valid http(s) URL.',
    duplicate: "You're already subscribed to that feed.",
    fetch: "Couldn't fetch that URL.",
    parse: "That URL isn't a feed, and no feed was found on that page.",
    folder: 'That folder no longer exists. Pick another.',
    not_found: 'That feed no longer exists.',
  }
  const base = reasons[result.reason]
  const detail = result.reason === 'fetch' && result.detail ? ` (${result.detail})` : ''
  return `${base}${detail}`
}

/**
 * The one add/edit feed form. Add and edit differ in three fields' initial
 * values, not in implementation: a URL change on edit goes through the same
 * fetch-validate-then-write path as an add.
 *
 * Mounted once in ReaderPage and driven by `session.feedForm`, so the sidebar
 * pencil and the feed menu open the same dialog instead of two copies of it.
 */
export const FeedFormDialog = () => {
  const r = useReader()
  const navigate = useNavigate()

  let dialogEl: HTMLDialogElement | undefined
  let urlEl: HTMLInputElement | undefined

  const [url, setUrl] = createSignal('')
  const [title, setTitle] = createSignal('')
  const [folder, setFolder] = createSignal('')
  const [newFolder, setNewFolder] = createSignal('')
  const [error, setError] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)

  const form = () => r.session.feedForm
  const isEdit = () => form()?.mode === 'edit'
  const editingFeed = createMemo(() => {
    const current = form()
    if (!current || current.mode !== 'edit' || current.feedId === null) return undefined
    return r.panel.allFeeds.find((feed) => feed.id === current.feedId)
  })
  const folders = createMemo(() =>
    [...r.panel.categories].sort((a, b) => compareTitlesCI(a.title, b.title)),
  )

  // Open/prefill on form change. The feed is snapshotted with untrack because
  // panel polling must not overwrite fields while the dialog is open.
  createEffect(
    () => form(),
    (current) => {
      if (!current) {
        if (dialogEl?.open) dialogEl.close()
        return
      }
      // Snapshot the feed at open time. The panel keeps polling while the form
      // is open; those updates must not rewrite fields the user is editing.
      const feed = untrack(() => {
        const row = editingFeed()
        return row
          ? { feedUrl: row.feedUrl, title: row.title, categoryId: row.categoryId }
          : null
      })
      setUrl(feed?.feedUrl ?? '')
      setTitle(feed?.title ?? '')
      setFolder(feed?.categoryId ?? '')
      setNewFolder('')
      setError(null)
      setBusy(false)
      if (!dialogEl?.open) {
        dialogEl?.showModal()
        urlEl?.focus()
      }
    },
  )

  /** Escape also fires this; the reader's session is the single close switch. */
  const onClose = (): void => {
    if (form()) r.closeFeedForm()
  }

  const onBackdropClick = (event: MouseEvent): void => {
    if (event.target === dialogEl) dialogEl.close()
  }

  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault()
    if (busy()) return
    setError(null)

    const feedUrl = url().trim()
    if (feedUrl === '') {
      setError('Enter a feed URL.')
      return
    }
    if (isEdit() && title().trim() === '') {
      setError('Enter a title.')
      return
    }

    const useNewFolder = folder() === NEW_FOLDER
    if (useNewFolder && newFolder().trim() === '') {
      setError('Name the new folder.')
      return
    }

    const folderArgs = useNewFolder
      ? { newCategoryTitle: newFolder().trim() }
      : { categoryId: folder() === '' ? null : folder() }

    setBusy(true)
    try {
      if (isEdit()) {
        const feed = editingFeed()
        if (!feed) {
          setError('That feed no longer exists.')
          return
        }
        const result = await api.editFeed({
          feedId: feed.id,
          title: title().trim(),
          feedUrl,
          ...folderArgs,
        })
        if (!result.ok) {
          setError(errorText(result))
          return
        }
        r.closeFeedForm()
        r.refreshPanel()
        r.reloadList()
      } else {
        const result = await api.addFeed({
          url: feedUrl,
          ...folderArgs,
        })
        if (!result.ok) {
          if (result.reason === 'duplicate' && result.feedId) {
            // Already subscribed: the add was a no-op, so take them to it.
            r.closeFeedForm()
            r.refreshPanel()
            await navigate(`/?feed=${result.feedId}`)
            return
          }
          setError(errorText(result))
          return
        }
        r.closeFeedForm()
        r.refreshPanel()
        await navigate(`/?feed=${result.feedId}`)
      }
    } catch (error) {
      console.error('feed form save failed', error)
      setError('Could not save the feed. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={(element) => {
        dialogEl = element
      }}
      aria-label={isEdit() ? 'Edit feed' : 'Add feed'}
      class="m-auto w-[min(28rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] overflow-y-auto p-0 rounded-xl border border-line bg-white shadow-xl text-sm backdrop:bg-black/40"
      onClick={onBackdropClick}
      onClose={onClose}
    >
      <form class="p-3 flex flex-col gap-2" onSubmit={(event) => void submit(event)}>
        <h2 class="font-semibold text-base">{isEdit() ? 'Edit feed' : 'Add feed'}</h2>

        <label class="text-xs font-semibold uppercase tracking-wide text-muted" for="feed-url">
          Feed URL
        </label>
        <input
          id="feed-url"
          ref={(element) => {
            urlEl = element
          }}
          type="text"
          inputmode="url"
          autocapitalize="off"
          autocomplete="off"
          spellcheck={false}
          class="w-full min-h-11 px-3 py-2 border border-line rounded-lg"
          value={url()}
          onInput={(event) => setUrl(event.currentTarget.value)}
        />

        <Show when={isEdit()}>
          <label class="text-xs font-semibold uppercase tracking-wide text-muted" for="feed-title">
            Title
          </label>
          <input
            id="feed-title"
            type="text"
            class="w-full min-h-11 px-3 py-2 border border-line rounded-lg"
            value={title()}
            onInput={(event) => setTitle(event.currentTarget.value)}
          />
        </Show>

        <label class="text-xs font-semibold uppercase tracking-wide text-muted" for="feed-folder">
          Folder
        </label>
        <select
          id="feed-folder"
          class="w-full min-h-11 px-3 py-2 border border-line rounded-lg bg-white"
          value={folder()}
          onChange={(event) => setFolder(event.currentTarget.value)}
        >
          <option value="">No folder</option>
          <For each={folders()}>
            {(category) => <option value={category.id}>{category.title}</option>}
          </For>
          <option value={NEW_FOLDER}>New folder…</option>
        </select>

        <Show when={folder() === NEW_FOLDER}>
          <input
            type="text"
            class="w-full min-h-11 px-3 py-2 border border-line rounded-lg"
            placeholder="New folder name"
            value={newFolder()}
            onInput={(event) => setNewFolder(event.currentTarget.value)}
          />
        </Show>

        <Show when={error()}>
          {(message) => (
            <p role="alert" data-testid="feed-form-error" class="text-red-700">
              {message()}
            </p>
          )}
        </Show>

        <div class="flex gap-2 pt-1">
          <button
            type="submit"
            disabled={busy()}
            class="flex-1 min-h-11 rounded-lg bg-accent text-white font-medium cursor-pointer hover:brightness-95 active:brightness-90 disabled:opacity-60"
          >
            {busy() ? 'Saving…' : isEdit() ? 'Save changes' : 'Add feed'}
          </button>
          <button
            type="button"
            class="flex-1 min-h-11 rounded-lg bg-gray-50 text-ink cursor-pointer hover:bg-gray-100 active:bg-gray-200"
            onClick={() => dialogEl?.close()}
          >
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  )
}

export default FeedFormDialog
