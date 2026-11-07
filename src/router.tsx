import { createRouter } from '@solidjs/router'
import ReaderPage from './pages/Reader'
import LoginPage from './pages/Login'
import SignupPage from './pages/Signup'
import NotFoundPage from './pages/NotFound'

/**
 * The route tree. Declared here rather than derived from filenames: one file to
 * read when you want to know what URLs exist.
 *
 * The reading view's whole identity (feed, category, starred, search) lives in
 * its query string, so `/` is the only reader route. The old app's `/feed/:id`
 * and `/search?q=` shapes are handled with real redirects in middleware, and
 * unknown paths are redirected there too — the NotFound route only catches what
 * a client-side navigation can produce.
 */
export const Router = createRouter({
  routes: [
    { path: '/', component: ReaderPage },
    { path: '/login', component: LoginPage },
    { path: '/signup', component: SignupPage },
    { path: '*404', component: NotFoundPage },
  ],
})
