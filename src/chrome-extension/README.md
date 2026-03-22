# Docreview Chrome Extension

Adds Docreview integration to Google Docs, Google Drive, and Gmail.

## What it does

### Google Docs
A Docreview icon appears in the document titlebar (next to the sharing badges). Click it to open the document in Docreview.

On "Access Denied" pages (documents you don't have permission to view), an "Add in Docreview" link appears above the "Request access" button. Clicking it opens the Add Document page with the doc URL prefilled and a note recording the request date.

### Google Drive
Docreview icons appear next to file type icons in both list and grid views (folders are excluded). Click any icon to open that file in Docreview.

On "You need access" pages (files you don't have permission to view), an "Add in Docreview" link appears above the "Request access" button, just like on Google Docs access-denied pages.

### Gmail
For Docs notification emails (comments, suggestions, sharing), an "Open in Docreview" link appears inside the email. Click it to open the referenced document in Docreview.

### Toolbar icon
Click the Docreview icon in Chrome's toolbar to open the current page in Docreview:
- On Google Docs/Sheets/Slides, opens the current document directly.
- On Gmail, finds the document link in the current email and opens it. Shows an alert if no document is found or if multiple different documents are linked.

### Shortened URL resolution
When adding a document via a shortened link (e.g. `go/my-doc`), the server first attempts to follow the redirect itself. If the server can't resolve it (e.g. the shortener requires browser cookies for authentication), and the extension's redirect-link resolver is enabled, the extension resolves the redirect by opening the URL in a background tab (which has the user's cookies). If the redirect lands on a Google Docs URL, it's captured and used for validation. The background tab is closed automatically once the redirect completes or fails. This feature is disabled by default in the extension settings.

### In-page comment navigation
When viewing a document's comments in Docreview, clicking "Open" on a comment navigates to that comment in the Google Docs tab without reloading the page. The extension tracks which Chrome tab has each document open (persisted in `chrome.storage.session`) — the first click opens a new tab, and subsequent clicks reuse it. If you open Docreview from a Google Docs tab (via the titlebar icon or toolbar icon), that tab is automatically tracked, so clicking "Open" in Docreview reuses the original tab instead of opening a new one.

The injected navigation script (`navigateToCommentInPage`) handles several complications:
- **Anchored comments** (open, with margin highlights): Navigates and closes the comments pane for a clean view.
- **Non-anchored comments** (resolved, unanchored): Opens the comments pane so the comment is visible, then navigates.
- **Suggestions without a disco ID**: Focuses the existing tab without scrolling.
- **Document tab switches**: Clicking a comment on a different document tab rebuilds the stream view DOM. The script clicks once to navigate, waits 300ms for the DOM to settle, then re-finds and clicks again to ensure selection.
- **Fallback**: If the comment can't be found in the component tree (e.g. Google changed their code), falls back to a page reload with `?disco=` in the URL.

See `docs/notes-on-comment-navigation.md` for detailed research notes on the Google Docs DOM structure and the complications encountered during implementation.

### Docreview app integration
The extension is automatically detected by the Docreview web app via a ping/response handshake over `window.postMessage`. The `docreview-bridge.js` content script is dynamically registered for the configured `baseUrl` and relays messages between the web page and the background worker. Each page instance gets a unique `pageId` so that cancellation of in-flight resolves is scoped per tab.

**Note:** The `http://localhost/*` entry in `host_permissions` is required for the dynamic content script registration to work in development. For non-localhost deployments, add the production URL to `host_permissions` in `manifest.json`.

### Right-click menu
Right-click the toolbar icon for:
- **Open Docreview** — opens the Docreview home page
- **Open Add Document** — opens the Docreview add document page
- **Options** — configure the Docreview server URL

## Installation

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `src/chrome-extension/` directory
5. The Docreview icon should appear in your Chrome toolbar

### Updating

After editing extension files, click the refresh icon on the extension's card in `chrome://extensions`, then reload any open Google Docs/Drive/Gmail tabs.

### Configuration

By default, the extension connects to `http://localhost:3000`. To change this:
1. Right-click the Docreview toolbar icon
2. Select **Options**
3. Enter your Docreview server URL
4. Click **Save**

After changing the URL, refresh any open Google Docs/Drive/Gmail tabs.

## How it works

The extension has four parts:

**`manifest.json`** — Manifest V3 configuration. Declares permissions (`storage`, `activeTab`, `contextMenus`, `scripting`, `tabs`), host permissions for Google domains and localhost, and registers the content script and service worker.

**`content.js`** — Runs on Google Docs, Drive, and Gmail pages. Injects Docreview icons by manipulating the DOM. Uses MutationObservers to handle dynamically loaded content (Google Workspace apps load UI elements after the initial page load). Adapted from the bookmarklet in `src/bookmarklet/bookmarklet-source.js` with two key changes: the base URL comes from `chrome.storage.sync`, and the Gmail link resolves its target URL at click time rather than injection time (to handle Gmail's SPA navigation correctly).

**`background.js`** — Service worker that handles toolbar clicks, context menu actions, and messages from content scripts. For Gmail, it uses `chrome.scripting.executeScript` with `allFrames: true` to search all frames (including sandboxed AMP iframes that content scripts can't access) for document URLs. Handles `ping` (returns extension status/version), `resolveUrl` (opens a background tab to follow redirects), `cancelResolve` (closes in-flight resolve tabs), and `navigateToComment` (tracks Google Docs tabs per document and injects navigation scripts via `executeScript` in MAIN world). Tab tracking is persisted in `chrome.storage.session` to survive MV3 service worker restarts. Dynamically registers the `docreview-bridge.js` content script for the configured `baseUrl`.

**`docreview-bridge.js`** — Content script dynamically registered for Docreview app pages. Relays `window.postMessage` calls from the web app to the background worker via `chrome.runtime.sendMessage`, and posts responses back. Each page instance generates a unique `pageId` to scope cancellation. Runs in the content script's isolated world; communication with the page is via `postMessage` only.

**`options.html` + `options.js`** — Settings page for configuring the Docreview server URL and feature toggles (Google Docs/Drive/Gmail integration, redirect-link resolver), stored in `chrome.storage.sync`.

**`defaults.js`** — Shared default configuration (base URL, feature toggles) loaded by all other scripts.

**`icons/`** — 16/48/128px PNGs converted from `public/docreview.svg`. If the source SVG changes, regenerate with:
```bash
for size in 16 48 128; do
  convert -background none -resize ${size}x${size} public/docreview.svg src/chrome-extension/icons/icon${size}.png
done
```

## Design notes

### Content script ↔ page communication

Chrome extension content scripts run in an **isolated JavaScript world** — they share the DOM with the page but have a separate `window` object. This means:

- Setting `window` properties in the content script is invisible to page JavaScript.
- Injecting inline `<script>` tags to run in the page's context is blocked by CSP.
- Setting DOM attributes on `<html>` works but causes React hydration errors (server-rendered HTML won't have the attribute).

The solution is `window.postMessage`, which crosses the isolation boundary. The bridge content script relays messages between the page and the background worker using postMessage in both directions. The web app detects the extension by sending a `ping` message and waiting for a response, rather than passively checking for a signal.

### Dynamic content script registration

The bridge content script is registered dynamically (via `chrome.scripting.registerContentScripts`) for the configured `baseUrl`, rather than being hardcoded in the manifest. This requires:

1. The target URL must be covered by `host_permissions` in `manifest.json`. Without this, registration appears to succeed but the script never injects. Currently `http://localhost/*` is hardcoded; non-localhost deployments need their URL added.
2. Dynamically registered scripts only inject into pages loaded **after** registration. After reloading the extension, refresh the Docreview page.
3. The content script runs at `document_idle`, so it may not be ready when React components mount. The web app handles this by sending a ping on mount and awaiting the response (with a 2s timeout) before checking extension status.
