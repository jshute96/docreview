# Chrome Extension Content Script Tests

Playwright tests that verify the Chrome extension's content script correctly
injects DOM elements into Google Docs, Drive, and Gmail pages.

## Quick start

```bash
npm run test:e2e
```

This starts a local HTTP server, loads saved DOM snapshots in headless Chrome,
injects the content script functions, and asserts the expected elements appear.
Runs in ~8 seconds with no network access or Google login needed.

## What's tested

Each Playwright test corresponds to a test case in `chrome-extension.md` (the
full test case catalog, which also includes manual-only cases not covered here).
Cases marked **[auto]** in that file are the ones implemented below.

| Playwright test | Snapshot | What it checks | `chrome-extension.md` case |
|-----------------|----------|----------------|---------------------------|
| Google Docs — fresh injection | `google-docs.html` | 1 `#dr-badge`, 1 `.dr-link` with `img` in `.docs-titlebar-badges` | Google Docs — fresh page |
| Google Docs — idempotency | `google-docs.html` | Still 1 `#dr-badge` after running twice | Google Docs — idempotency |
| Google Sheets — badge | `google-sheets.html` | 1 `#dr-badge`, 1 `.dr-link` (same `injectDocs` path) | Google Sheets — titlebar badge |
| Google Slides — badge | `google-slides.html` | 1 `#dr-badge`, 1 `.dr-link` | Google Slides — titlebar badge |
| Google Drive — list icons | `google-drive-list.html` | `.dr-link` count matches qualifying `tr[role="row"]` rows with `[data-id]` > 20 chars | Google Drive — list view |
| Google Drive — idempotency | `google-drive-list.html` | Same `.dr-link` count after running twice | Google Drive — idempotency |
| Gmail inbox — chip icons | `gmail-inbox.html` | `.dr-link` count matches `[data-docurl]` chip count | Gmail — inbox list chips |
| Gmail inbox — idempotency | `gmail-inbox.html` | Same `.dr-link` count after running twice | Gmail — inbox list idempotency |
| Gmail message — bar | `gmail-message.html` | `.dr-gmail-bar` exists, contains "Open in Docreview" text and icon | Gmail — message view bar |
| Gmail message — idempotency | `gmail-message.html` | Same `.dr-gmail-bar` count after running twice | Gmail — message view bar idempotency |

## How it works

1. **Snapshots** are saved rendered DOM from live Google pages, stored as static
   HTML in `testing/snapshots/`. Scripts are stripped so the page is inert.

2. **Playwright** loads each snapshot via a local Python HTTP server (port 8889,
   started automatically by `playwright.config.ts`).

3. The test **extracts function definitions** from `src/chrome-extension/content.js`
   by parsing balanced braces — `createIconButton`, `injectDocs`, `injectDrive`,
   `injectGmail`, etc.

4. It wraps them in an IIFE that provides mocked variables (`baseUrl`, `iconUrl`,
   a shadowed `location` object matching the expected Google domain) and calls
   the appropriate injection function via `page.evaluate()`.

5. Standard Playwright assertions check element counts, attributes, and text.

This approach bypasses the content script's `location.hostname` check and
`chrome.storage.sync` dependency while testing the actual injection logic
against real Google DOM structures.

## What's NOT tested here

These tests cover DOM injection logic only. The remaining cases in
`chrome-extension.md` (marked **[manual]**) require the real extension loaded
in Chrome and are not automated. They fall into these categories:

- **Click handlers** — icon click opens new tab (Docs, Drive, Gmail chip, Gmail bar)
- **MutationObserver** — re-injection after SPA navigation (Drive, Gmail)
- **Toolbar button** — all 7 cases (background service worker behavior)
- **Drive grid view** — needs a grid-view snapshot (not yet captured)
- **Gmail direct page load** — `.dr-gmail-bar` should NOT appear
- **Non-Google page** — content script should not run
- **Settings/storage** — enable/disable per surface via `chrome.storage.sync`
- **Comment activity detection** — `mouseup`/`keydown` listeners on Docs

## Files

```
testing/
  README.md                    — this file
  chrome-extension.md          — full test case descriptions (auto/manual tags)
  content-script.spec.ts       — Playwright test file
  playwright.config.ts         — Playwright config (system Chrome, snapshot server)
  snapshots/                   — saved DOM snapshots (gitignored)
    google-docs.html
    google-sheets.html
    google-slides.html
    google-drive-list.html
    gmail-inbox.html
    gmail-message.html
```

## Capturing new snapshots

Snapshots need to be recaptured when Google changes their DOM structure
(selectors break) or when you need a new surface (e.g., Drive grid view).

### Using the Playwright MCP browser

1. Open a browser with Playwright MCP (the `mcp__playwright2__browser_*` tools).
2. Log in with a test user from `testing/test_users.json`.
3. Navigate to the target page and wait for it to fully render.
4. Run this in the browser console via `browser_evaluate`:

```javascript
() => {
  const clone = document.documentElement.cloneNode(true);
  clone.querySelectorAll('script').forEach(s => s.remove());
  const html = '<!DOCTYPE html>\n' + clone.outerHTML;
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'snapshot-name.html';
  a.click();
  URL.revokeObjectURL(url);
  return 'Saved ' + html.length + ' bytes';
}
```

5. The file downloads to `.playwright-mcp/`. Copy it to `testing/snapshots/`:

```bash
cp .playwright-mcp/snapshot-name.html testing/snapshots/
```

### Verifying a snapshot has the right selectors

Before using a snapshot in tests, check that the key selectors exist:

```javascript
// Google Docs/Sheets/Slides
() => ({
  hasBadges: !!document.querySelector('.docs-titlebar-badges'),
  hasDocId: !!location.pathname.match(/\/d\/([a-zA-Z0-9_-]+)/)
})

// Google Drive
() => ({
  rows: document.querySelectorAll('tr[role="row"]').length,
  qualifyingIds: [...document.querySelectorAll('[data-id]')]
    .filter(el => el.getAttribute('data-id').length > 20).length
})

// Gmail inbox
() => ({ chips: document.querySelectorAll('[data-docurl]').length })

// Gmail message view
() => ({
  msgDivs: document.querySelectorAll('[data-message-id]').length,
  overviewCards: document.querySelectorAll('[id$="overview-card-contents"]').length,
  iframes: document.querySelectorAll('[data-message-id] iframe').length
})
```

### What survives in a snapshot

**Preserved:** DOM structure, attributes, classes, inline styles, data
attributes, ARIA roles, element hierarchy.

**Not preserved:** iframe content (cross-origin), external images (CORS),
JavaScript behavior (stripped), some computed styles.

See `docs/notes-on-dom-snapshot-testing.md` for more details.

## Troubleshooting

**Tests fail with "0 elements found"**: The snapshot DOM has changed or the
content script selectors no longer match. Recapture the snapshot from a live
page and check the selectors.

**Port 8889 already in use**: Another process is using the port. Kill it or
change the port in `playwright.config.ts`.

**"Executable doesn't exist"**: Playwright can't find Chrome. The config uses
`channel: 'chrome'` (system Chrome). Make sure Chrome is installed, or remove
the `channel` option and run `npx playwright install` to use bundled Chromium.
