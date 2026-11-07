import type { JSX } from '@solidjs/web'
import { HydrationScript } from '@solidjs/web'

/**
 * The HTML shell. Static PWA files keep their historical paths (/manifest.json,
 * /favicon.svg, /apple-touch-icon.png) so an installed reader keeps working.
 *
 * The stylesheet is a build artifact (see the `build:css` script): Tailwind 4
 * compiles src/app.css into public/style.css, which is then served as a static
 * file and linked here.
 */
export default function Document(props: { children?: JSX.Element }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>spfy rss</title>
        <meta name="description" content="A focused, self-hosted RSS reader." />
        <meta name="theme-color" content="#0e7490" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="spfy rss" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <link rel="manifest" href="/manifest.json" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="icon" href="/favicon.png" sizes="192x192" type="image/png" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="stylesheet" href="/style.css" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Lora:ital,wght@0,400;0,500;0,600;1,400;1,500;1,600&display=swap"
          rel="stylesheet"
        />
        <HydrationScript />
      </head>
      <body>
        <noscript>You need to enable JavaScript to run this reader.</noscript>
        {props.children}
      </body>
    </html>
  )
}
