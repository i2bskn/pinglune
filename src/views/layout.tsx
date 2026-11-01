/** @jsxImportSource hono/jsx */
import { html } from "hono/html";
import type { Child } from "hono/jsx";
import { BRAND_NAME, BRAND_TAGLINE } from "../brand";

// The screens served by the Worker (login, setup, consent). They are styled by /server-pages.css, a static
// asset (client/public), because the SPA's stylesheet has a hashed name.
export function Layout(props: { title: string; children?: Child }) {
  return html`<!DOCTYPE html>${(
    <html lang="ja">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#f4f5f2" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#121617" media="(prefers-color-scheme: dark)" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="stylesheet" href="/server-pages.css" />
        <title>{`${props.title} - ${BRAND_NAME}`}</title>
      </head>
      <body>
        <div class="shell">
          <a href="/" class="brand">
            <span class="brand-name">{BRAND_NAME}</span>
          </a>
          <p class="tagline">{BRAND_TAGLINE}</p>
          <main class="card">{props.children}</main>
        </div>
      </body>
    </html>
  )}`;
}
