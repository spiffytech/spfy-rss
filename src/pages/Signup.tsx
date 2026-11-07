import { Show, createSignal, onSettled } from 'solid-js'
import { useNavigate } from '@solidjs/router'

import * as api from '../server/actions'

/**
 * Self-service registration. The form exists only when the server allows it;
 * the action re-checks, so a direct visit (or a bookmarked form) cannot create
 * an account once `ALLOW_SIGNUP=0`.
 */
export const SignupPage = () => {
  const navigate = useNavigate()
  const [enabled, setEnabled] = createSignal<boolean | null>(null)
  const [username, setUsername] = createSignal('')
  const [password, setPassword] = createSignal('')
  const [confirm, setConfirm] = createSignal('')
  const [error, setError] = createSignal('')
  const [submitting, setSubmitting] = createSignal(false)

  onSettled(() => {
    api
      .signupConfig()
      .then((config) => setEnabled(config.enabled))
      .catch(() => setEnabled(false))
  })

  const onSubmit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault()
    setError('')
    if (password() !== confirm()) {
      setError('Passwords do not match.')
      return
    }
    setSubmitting(true)
    try {
      await api.register(username(), password())
      await navigate('/')
    } catch (failure) {
      const status = failure instanceof Response ? failure.status : null
      setError(
        status === 403
          ? 'Signups are closed on this server.'
          : status === 409
            ? 'That username is taken.'
            : status === 400
              ? 'Use 1–64 characters: letters, digits, dot, dash or underscore. Password at least 8 characters.'
              : 'Could not create the account.',
      )
      setPassword('')
      setConfirm('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main class="min-h-dvh bg-gray-50 text-gray-900 flex items-center justify-center p-4">
      <Show
        when={enabled() !== false}
        fallback={
          <div class="login-card bg-white border border-gray-200 rounded-lg shadow-sm p-8 w-full max-w-sm text-center">
            <h1 class="text-lg font-semibold mb-2">Signups are closed</h1>
            <p class="text-sm text-gray-500 mb-4">This server does not accept new accounts.</p>
            <a href="/login" class="text-sm text-cyan-700 hover:underline">
              Back to sign in
            </a>
          </div>
        }
      >
        <form
          class="login-card bg-white border border-gray-200 rounded-lg shadow-sm p-8 flex flex-col gap-6 w-full max-w-sm"
          onSubmit={(event) => void onSubmit(event)}
        >
          <div class="flex flex-col items-center gap-3 text-center">
            <div class="flex flex-col gap-1.5">
              <h1 class="text-lg font-semibold leading-6">Create an account</h1>
              <p class="text-sm text-gray-500 leading-5">
                Your feeds, read state and preferences are private to this account.
              </p>
            </div>
          </div>

          <div class="flex flex-col gap-4">
            <label class="flex flex-col gap-1.5 text-sm font-medium">
              <span>Username</span>
              <input
                name="username"
                required
                autocomplete="username"
                class="border border-gray-300 rounded-md px-3 py-2 text-sm font-normal placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-cyan-700 focus:border-cyan-700"
                value={username()}
                onInput={(event) => setUsername(event.currentTarget.value)}
              />
            </label>
            <label class="flex flex-col gap-1.5 text-sm font-medium">
              <span>Password</span>
              <input
                name="password"
                type="password"
                required
                minlength="8"
                autocomplete="new-password"
                class="border border-gray-300 rounded-md px-3 py-2 text-sm font-normal placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-cyan-700 focus:border-cyan-700"
                value={password()}
                onInput={(event) => setPassword(event.currentTarget.value)}
              />
            </label>
            <label class="flex flex-col gap-1.5 text-sm font-medium">
              <span>Confirm password</span>
              <input
                name="confirm"
                type="password"
                required
                minlength="8"
                autocomplete="new-password"
                class="border border-gray-300 rounded-md px-3 py-2 text-sm font-normal placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-cyan-700 focus:border-cyan-700"
                value={confirm()}
                onInput={(event) => setConfirm(event.currentTarget.value)}
              />
            </label>
          </div>

          <Show when={error() !== ''}>
            <p role="alert" class="text-sm text-red-600">
              {error()}
            </p>
          </Show>

          <button
            type="submit"
            disabled={submitting()}
            class="self-center min-w-40 w-full sm:w-auto bg-cyan-700 text-white rounded-full px-10 py-2.5 font-medium shadow-sm hover:bg-cyan-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-700 focus-visible:ring-offset-2 active:bg-cyan-900 active:translate-y-px disabled:opacity-60 disabled:translate-y-0"
          >
            Create account
          </button>

          <a href="/login" class="text-center text-sm text-gray-500 hover:text-gray-700">
            Already have an account? Sign in
          </a>
        </form>
      </Show>
    </main>
  )
}

export default SignupPage
