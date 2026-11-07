import { Show, createSignal } from 'solid-js'

import * as api from '../server/actions'
import { useReader } from '../lib/reader-context'

/**
 * OPML import/export, parked at the end of the sidebar. One surface for both:
 * the home page is a navigation aid, not a settings page.
 */
export const OpmlControls = () => {
  const r = useReader()
  const [importing, setImporting] = createSignal(false)
  const [message, setMessage] = createSignal<string | null>(null)

  const onImport = async (event: Event & { currentTarget: HTMLInputElement }): Promise<void> => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
    setImporting(true)
    setMessage(null)
    try {
      const result = await api.importOpml(await file.text())
      if (!result.ok) {
        setMessage(
          result.reason === 'too_large'
            ? 'That OPML file is too large.'
            : 'That file is not valid OPML.',
        )
        return
      }
      const parts = [`Imported ${result.imported} ${result.imported === 1 ? 'feed' : 'feeds'}`]
      if (result.existing > 0) parts.push(`${result.existing} already subscribed`)
      if (result.invalid > 0) parts.push(`${result.invalid} invalid`)
      setMessage(`${parts.join(', ')}. Fetching starts in the background.`)
      r.refreshPanel()
    } catch {
      setMessage('Could not import that file.')
    } finally {
      setImporting(false)
    }
  }

  return (
    <div class="mt-4 pt-3 border-t border-line">
      <h2 class="font-semibold text-sm mb-1">Subscriptions</h2>
      <div class="flex flex-col gap-1">
        <label class="menu-row cursor-pointer">
          {importing() ? 'Importing…' : 'Import OPML…'}
          <input
            type="file"
            accept=".opml,.xml,text/xml,application/xml,text/x-opml"
            class="hidden"
            disabled={importing()}
            onChange={(event) => void onImport(event)}
          />
        </label>
        <a href="/opml" class="menu-row">
          Export OPML
        </a>
      </div>
      <Show when={message()}>
        {(text) => (
          <p role="status" class="mt-2 text-xs text-gray-600">
            {text()}
          </p>
        )}
      </Show>
    </div>
  )
}

export default OpmlControls
