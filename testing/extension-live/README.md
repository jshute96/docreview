# Extension Live Tests

Tests that run docreview with the Chrome extension loaded. The extension
is loaded via `--load-extension` in a Playwright persistent browser context
using the bundled Chromium (system Chrome removed support for side-loading
extensions).

## Prerequisites

1. Set up the test database: `testing/setup-test-db.sh`
2. Install Playwright's bundled Chromium: `npx playwright install chromium`
3. Chrome extension source in `src/chrome-extension/`

## Run

```bash
npm run test:e2e:extension-live

# Or a specific test file:
scripts/run-test.sh testing/extension-live/toolbar.spec.ts
```

Extension tests require headed mode (Chromium's headless shell doesn't
support extensions). The fixtures set `headless: false` automatically.

## Fixtures

The custom fixtures in `fixtures.ts` provide:

- **`context`** — Persistent browser context with the extension loaded
- **`background`** — The extension's background service worker
- **`extensionId`** — The extension's Chrome ID
- **`extPage`** — The extension's options page (`chrome-extension://<id>/options.html`)
  with full chrome API access (storage, runtime messaging, tabs)

`worker.evaluate()` runs in a sandboxed context that lacks most chrome
APIs (storage, scripting, action). The `extPage` fixture provides a real
extension-origin page where all APIs work.

## Testing toolbar clicks

Playwright can't click extension toolbar icons. Instead, tests send a
`_test:toolbarClick` message via `chrome.runtime.sendMessage` from the
`extPage`, which the background script handles by calling
`handleToolbarClick(tab)`.
