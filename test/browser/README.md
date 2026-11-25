# Consent form browser regression

From the repository root, with Playwright installed and a Chromium browser available:

```sh
node --test test/browser/consent.test.mjs
```

This Cloud environment already provides Playwright and Chromium, so no dependency installation is needed:

```sh
NODE_PATH=/opt/codex/cua_node/lib/node_modules CHROMIUM_PATH=/usr/bin/chromium \
  node --test test/browser/consent.test.mjs
```

The test renders the actual `ConsentPage` and serves the actual `client/public/consent.js` on an ephemeral loopback HTTP server. It opens `/authorize?client_id=dummy` in a fresh headless Chromium context. Browser requests outside that server are blocked. The POST response is delayed/mocked; there are no real users, grants, tokens, or external callbacks.

Coverage: repeated approval/denial and submit events, exact native POST fields (including the chosen Bot), keyboard approval without Bots, success redirects, HTTP 400/401/500 error navigation and retry, JavaScript-disabled fallback, and simulated persisted `pageshow` recovery. The bfcache event is simulated; actual browser history caching and a real OAuth provider redirect are not verified here. Existing `test/mcp.test.ts` exercises the real Worker OAuth routes with local test bindings.

Validation on 2026-11-25:

- Browser regression: 8 passed.
- Negative control: removing the new script made the approval test fail (buttons remained enabled); script restored afterward.
- `pnpm typecheck`: passed.
- `pnpm test`: 58 files, 1,936 tests passed (the initial invocation with positional arguments after `--` ran the full suite).
- `pnpm build:client`: passed; built `dist/client/consent.js` matches the source.
- `git diff --check`: passed.

The change prevents duplicate operations in one loaded consent page while its native form submission is pending. It does not add server-side idempotency, and the observed production error has not been attributed to duplicate submission. No production access, deployment, push, merge, or PR creation was performed.

Review all changes, including new files:

```sh
git diff -- src/views/consent.tsx
git diff --no-index -- /dev/null client/public/consent.js
git diff --no-index -- /dev/null test/browser/consent.test.mjs
git status --short
```

`git diff --no-index` exits with status 1 when it displays a difference; that is expected.
