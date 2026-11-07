import { Show, createSignal, onSettled } from 'solid-js'
import { useNavigate } from '@solidjs/router'

import * as api from '../server/actions'

/**
 * The login screen. Structure and classes come verbatim from the pre-port reader;
 * one truthful deviation: the copy no longer claims a session-only Miniflux API
 * key — sessions here are HMAC-signed cookies on this server.
 */
export const LoginPage = () => {
  const navigate = useNavigate()
  const [username, setUsername] = createSignal('')
  const [password, setPassword] = createSignal('')
  const [error, setError] = createSignal('')
  const [submitting, setSubmitting] = createSignal(false)
  const [signupEnabled, setSignupEnabled] = createSignal(false)

  onSettled(() => {
    api
      .signupConfig()
      .then((config) => setSignupEnabled(config.enabled))
      .catch(() => setSignupEnabled(false))
  })

  const onSubmit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      await api.login(username(), password())
      await navigate('/')
    } catch {
      setError('Sign-in failed. Check your credentials.')
      setPassword('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main class="min-h-dvh bg-gray-50 text-gray-900 flex items-center justify-center p-4">
      <form
        class="login-card bg-white border border-gray-200 rounded-lg shadow-sm p-8 flex flex-col gap-6 w-full max-w-sm"
        onSubmit={(event) => void onSubmit(event)}
      >
        <div class="flex flex-col items-center gap-3 text-center">
          <svg aria-hidden="true" viewBox="0 0 32 32" class="w-14 h-14">
            <rect width="32" height="32" rx="6" fill="#3aafdd" />
            <text
              x="16"
              y="20.5"
              font-size="12.7"
              font-family="sans-serif"
              font-weight="bold"
              text-anchor="middle"
              fill="white"
            >
              SR
            </text>
          </svg>
          <div class="flex flex-col gap-1.5">
            <h1 class="text-lg font-semibold leading-6">Sign in to spfy rss</h1>
            <p class="text-sm text-gray-500 leading-5">
              Uses your reader username and password. Sessions are cookie-based and expire after 30
              days; signing out clears this browser's session.
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
              autocomplete="current-password"
              class="border border-gray-300 rounded-md px-3 py-2 text-sm font-normal placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-cyan-700 focus:border-cyan-700"
              value={password()}
              onInput={(event) => setPassword(event.currentTarget.value)}
            />
          </label>
        </div>

        {error() !== '' && (
          <p id="err" role="alert" class="text-sm text-red-600">
            {error()}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting()}
          class="self-center min-w-40 w-full sm:w-auto bg-cyan-700 text-white rounded-full px-10 py-2.5 font-medium shadow-sm hover:bg-cyan-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-700 focus-visible:ring-offset-2 active:bg-cyan-900 active:translate-y-px disabled:opacity-60 disabled:translate-y-0"
        >
          Sign in
        </button>

        <Show when={signupEnabled()}>
          <a href="/signup" class="text-center text-sm text-gray-500 hover:text-gray-700">
            Need an account? Sign up
          </a>
        </Show>
      </form>
    </main>
  )
}

export default LoginPage
