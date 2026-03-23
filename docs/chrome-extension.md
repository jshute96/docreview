# Chrome Extension — Design & Implementation

See `src/chrome-extension/README.md` for user-facing documentation.

## Files

**`manifest.json`** — Manifest V3 configuration. Declares permissions (`storage`, `activeTab`, `contextMenus`, `scripting`, `tabs`), host permissions for Google domains and localhost, and registers the content script and service worker.

**`content.js`** — Runs on Google Docs, Drive, and Gmail pages. Injects Docreview icons by manipulating the DOM. Uses MutationObservers to handle dynamically loaded content (Google Workspace apps load UI elements after the initial page load). Adapted from the bookmarklet in `src/bookmarklet/bookmarklet-source.js` with two key changes: the base URL comes from `chrome.storage.sync`, and the Gmail link resolves its target URL at click time rather than injection time (to handle Gmail's SPA navigation correctly).

**`background.js`** — Service worker that handles toolbar clicks, context menu actions, and messages from content scripts. For Gmail, it uses `chrome.scripting.executeScript` with `allFrames: true` to search all frames (including sandboxed AMP iframes that content scripts can't access) for document URLs. Handles `ping` (returns extension status/version), `resolveUrl` (opens a background tab to follow redirects), `cancelResolve` (closes in-flight resolve tabs), and `navigateToComment` (tracks Google Docs tabs per document and injects navigation scripts via `executeScript` in MAIN world). Tab tracking is persisted in `chrome.storage.session` to survive MV3 service worker restarts. Dynamically registers the `docreview-bridge.js` content script for the configured `baseUrl`.

**`docreview-bridge.js`** — Content script dynamically registered for Docreview app pages. Relays `window.postMessage` calls from the web app to the background worker via `chrome.runtime.sendMessage`, and posts responses back. Each page instance generates a unique `pageId` to scope cancellation. Runs in the content script's isolated world; communication with the page is via `postMessage` only.

**`options.html` + `options.js`** — Settings page for configuring the Docreview server URL and feature toggles (Google Docs/Drive/Gmail integration, redirect-link resolver), stored in `chrome.storage.sync`. The "Enable on Google Docs" toggle controls both content script injection and comment navigation — the setting is included in the ping response so the web app knows whether to use in-page navigation or fall back to page reloads.

**`defaults.js`** — Shared default configuration (base URL, feature toggles) loaded by all other scripts.

**`icons/`** — 16/48/128px PNGs converted from `public/docreview.svg`. If the source SVG changes, regenerate with:
```bash
for size in 16 48 128; do
  convert -background none -resize ${size}x${size} public/docreview.svg src/chrome-extension/icons/icon${size}.png
done
```

## Docreview app integration

The extension is automatically detected by the Docreview web app via a ping/response handshake over `window.postMessage`. The `docreview-bridge.js` content script is dynamically registered for the configured `baseUrl` and relays messages between the web page and the background worker. Each page instance gets a unique `pageId` so that cancellation of in-flight resolves is scoped per tab.

**Note:** The `http://localhost/*` entry in `host_permissions` is required for the dynamic content script registration to work in development. For non-localhost deployments, add the production URL to `host_permissions` in `manifest.json`.

## Comment navigation implementation

The injected navigation script (`navigateToCommentInPage`) handles several complications:

- **Disco ID discovery**: Comment disco IDs are stored deep in Google's Closure Library component tree under minified property names that change between releases. Instead of hardcoding these names, the script discovers the correct path dynamically by walking the tree and looking for AAAB-pattern ID strings. With 2+ comments, it diffs two items to find paths that differ (per-item ID) vs paths through array indices (shared model). With 1 comment, it finds the shortest non-array path. The discovered path is used for all items within a single navigation call.
- **Anchored comments** (open, with margin highlights): Navigates and closes the comments pane for a clean view.
- **Non-anchored comments** (resolved, unanchored): Opens the comments pane so the comment is visible, then navigates.
- **Suggestions without a disco ID**: Focuses the existing tab without scrolling.
- **Document tab switches**: Clicking a comment on a different document tab rebuilds the stream view DOM. The script clicks once to navigate, waits 300ms for the DOM to settle, then re-finds and clicks again to ensure selection.
- **Fallback**: If the comment can't be found in the component tree (e.g. Google changed their code), falls back to a page reload with `?disco=` in the URL.

See `docs/notes-on-comment-navigation.md` for detailed research notes on the Google Docs DOM structure and the complications encountered during implementation.

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
