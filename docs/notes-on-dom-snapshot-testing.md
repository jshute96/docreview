# Notes on DOM Snapshot Testing for Content Script Development

Working notes on using saved DOM snapshots to iterate on the Chrome extension's content script without needing live Google sessions.

## The idea

The content script is DOM manipulation: query elements by selectors, inject new elements, check guards. We can save the rendered DOM from a live page, load it in Playwright, and run content script code against it. This gives us:

- **Deterministic state** — no login, no SPA timing, no network flakiness
- **Before/after comparison** — load the snapshot in two tabs, run the injection on one, compare
- **Fast iteration** — try different versions of the content script without navigating back to the live page
- **Visual verification** — Playwright screenshots show the rendered result

We still need live-page testing for: MutationObserver behavior, event interception (stopImmediatePropagation vs Drive's listeners), window.open actually opening tabs, and visual fidelity of the full page.

## How to save a snapshot

`page.content()` returns the **source HTML**, which for SPAs like Gmail is just a loader shell — it won't render the app. Instead, serialize the **rendered DOM** after JS has built it, and strip scripts to prevent them from running (and failing) when reloaded:

```javascript
const html = await page.evaluate(() => {
  const clone = document.documentElement.cloneNode(true);
  clone.querySelectorAll('script').forEach(s => s.remove());
  return '<!DOCTYPE html>\n' + clone.outerHTML;
});
```

To save the file from Playwright MCP (which doesn't have Node fs access), trigger a download from the page:

```javascript
await page.evaluate((h) => {
  const blob = new Blob([h], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'snapshot-name.html';
  a.click();
  URL.revokeObjectURL(url);
}, html);
```

The file downloads to `.playwright-mcp/`. Copy it to `testing/snapshots/`.

## How to load a snapshot

Open the HTML file directly in a browser via `file://` URL — no server needed.

Playwright MCP blocks `file://` URLs, so when testing via Playwright you need a local HTTP server:

```bash
cd testing/snapshots && python3 -m http.server 8888
```

Then navigate to `http://localhost:8888/snapshot-name.html`.

## What survives in the snapshot

**Preserved:**
- Full DOM structure with all elements, attributes, classes, and inline styles
- Data attributes (`[data-docurl]`, `[data-id]`, `[data-message-id]`, `[data-column-id]`, etc.)
- ARIA roles (`[role="row"]`, `[role="gridcell"]`)
- CSS classes (`.docs-titlebar-badges`, etc.)
- Element hierarchy and parent/child relationships
- CSS stylesheets loaded from external URLs (cached by browser or inlined)

**Not preserved:**
- Iframe content — `cloneNode` saves the iframe element and its `src`, but not the cross-origin document inside it. The iframe shows "refused to connect" when loaded from localhost.
- External images — may fail to load due to CORS or broken relative URLs
- JavaScript behavior — stripped intentionally
- Computed styles from JS — inline styles set by JS are preserved, but dynamic style changes won't happen

## What we verified (Gmail comment notification)

Saved `testing/snapshots/gmail-comment-notification.html` from a live Gmail message view. Key findings:

- Gmail's rendered DOM is ~4MB. Loading it in Playwright works fine.
- The accessibility snapshot of the loaded file closely matches the live page — same structure, buttons, labels, message headers.
- `[data-docurl]` chip elements are present with correct URLs. The content script's `injectGmail()` found them and injected `.dr-link` icons.
- `[data-message-id]` div and its child iframe are present. The message-view bar injection worked — `.dr-gmail-bar` was created above the iframe.
- Idempotency guards (`.querySelector('.dr-link')`, `.querySelector('.dr-gmail-bar')`) work correctly.
- The email body iframe shows a grey box ("refused to connect") but this doesn't matter — the content script cannot access the cross-origin iframe content and gets doc URLs from top-level `[data-docurl]` chips instead.

## Known issues

### Hostname check
The content script checks `location.hostname` to decide what to inject (Docs, Drive, or Gmail). When loaded from `localhost:8888`, this check fails. Current workaround: run just the injection function (`injectGmail()`, `injectDrive()`, `injectDocs()`) directly, bypassing the hostname guard. A cleaner solution would be to refactor the content script so the hostname routing and injection logic are separate, or to add a test mode.

### File size
Gmail snapshots are ~4MB. Could potentially trim non-essential DOM (sidebar, hidden elements) to make snapshots smaller and easier to inspect, but hasn't been a practical problem so far.

### Missing CSS
Some Google-hosted stylesheets may not load from localhost, causing minor visual differences. The DOM structure is correct — just the styling may be off.

## Potential next steps

- Save snapshots for other surfaces: Google Docs titlebar, Drive list view, Drive grid view, Gmail inbox list
- Build a helper script to automate: save snapshot, serve it, open before/after tabs
- Consider jsdom/happy-dom for fast non-visual tests (selector validation, injection logic, idempotency) that run in CI without a browser
- Could evolve into a test skill for iterating on content script changes against saved snapshots
