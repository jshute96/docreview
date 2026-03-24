# Chrome Extension — Design & Implementation

See `src/chrome-extension/README.md` for user-facing documentation.

## Architecture

The extension has three main scripts that run in different contexts:

- **`content.js`** — Content script injected into Google Docs, Drive, and Gmail pages. Runs in Chrome's isolated content script world (shares the DOM but has a separate `window`). Injects Docreview icons into pages and detects comment activity on Google Docs.

- **`background.js`** — Service worker (Manifest V3). Runs in the extension's background context, independent of any page. Handles toolbar clicks, context menus, tab tracking, comment navigation, URL resolution, and server-side comment sync. Communicates with content scripts via `chrome.runtime.onMessage` / `chrome.tabs.sendMessage`.

- **`bridge-to-docreview.js`** — Content script dynamically registered for Docreview app pages only. Bridges communication between the web app (page world) and the background worker (extension world) using `window.postMessage` ↔ `chrome.runtime.sendMessage`. Also relays unsolicited messages from the background worker to the page (e.g., `commentSynced` notifications).

Communication flow:

```
Google Docs page                    Docreview page
  content.js                          bridge-to-docreview.js ↔ bridge-to-extension.ts (React app)
       ↕ chrome.runtime messages            ↕ chrome.runtime messages + window.postMessage
                    background.js
                (service worker)
```

## Files

**`manifest.json`** — Manifest V3 configuration. Declares permissions (`storage`, `activeTab`, `contextMenus`, `scripting`, `tabs`), host permissions for Google domains and localhost, and registers the content script and service worker.

**`content.js`** — Runs on Google Docs, Drive, and Gmail pages. Uses MutationObservers to handle dynamically loaded content (Google Workspace apps load UI elements after the initial page load). The base URL comes from `chrome.storage.sync`.

- **Google Docs**: Injects a Docreview icon into the titlebar. Detects comment activity (reply, resolve, accept/reject suggestion, new comment) via mouseup and keyboard listeners, and notifies the background worker to trigger a server-side comment sync.
- **Google Drive**: Injects Docreview icons next to file type icons in list and grid views.
- **Gmail**: Injects icons into attachment chips and "Open in Docreview" links into Docs notification emails. The link resolves its target URL at click time rather than injection time (to handle Gmail's SPA navigation correctly).
- **Access-denied pages**: Injects an "Add in Docreview" link on Docs and Drive access-denied pages.

**`background.js`** — Service worker that handles toolbar clicks, context menu actions, and messages from content scripts. Dynamically registers the `bridge-to-docreview.js` content script for the configured `baseUrl`. Tab tracking is persisted in `chrome.storage.session` to survive MV3 service worker restarts.

Message handlers:
- `commentActivity` — Debounces and triggers server-side comment sync via `POST /api/docs/sync-comments/[googleDocId]`, then notifies the first open Docreview tab via `chrome.tabs.sendMessage`.
- `ping` — Returns extension status and version.
- `resolveUrl` — Opens a background tab to follow redirects for shortened URLs.
- `cancelResolve` — Closes in-flight resolve tabs.
- `focusDocTab` — Focuses an existing Google Docs tab without creating a new one.
- `navigateToComment` — Tracks Google Docs tabs per document and injects navigation scripts via `executeScript` in MAIN world.
- `openDocInDocreview` — Opens a doc from Gmail in Docreview, using `chrome.scripting.executeScript` with `allFrames: true` to search all frames (including sandboxed AMP iframes).

**`bridge-to-docreview.js`** — Content script dynamically registered for Docreview app pages.

- Relays `window.postMessage` calls from the web app to the background worker via `chrome.runtime.sendMessage`, and posts responses back.
- Handles unsolicited messages from the background worker (e.g., `commentSynced` after a server-side comment sync) and relays them to the page.
- Each page instance generates a unique `pageId` to scope cancellation.
- Runs in Chrome's isolated content script world; communication with the page is via `postMessage` only.

**`options.html` + `options.js`** — Settings page for configuring the Docreview server URL and feature toggles (Google Docs/Drive/Gmail integration, comment activity notifications, redirect-link resolver), stored in `chrome.storage.sync`. The "Enable on Google Docs" toggle controls both content script injection and comment navigation — the setting is included in the ping response so the web app knows whether to use in-page navigation or fall back to page reloads. The "Notify on comment activity" sub-toggle controls comment activity auto-sync and is only selectable when "Enable on Google Docs" is on.

**`defaults.js`** — Shared default configuration (base URL, feature toggles) loaded by all other scripts.

**`icons/`** — 16/48/128px PNGs converted from `public/docreview.svg`. If the source SVG changes, regenerate with:
```bash
for size in 16 48 128; do
  convert -background none -resize ${size}x${size} public/docreview.svg src/chrome-extension/icons/icon${size}.png
done
```

## Docreview app integration

The extension is automatically detected by the Docreview web app via a ping/response handshake over `window.postMessage`. The `bridge-to-docreview.js` content script is dynamically registered for the configured `baseUrl` and relays messages between the web page and the background worker. Each page instance gets a unique `pageId` so that cancellation of in-flight resolves is scoped per tab.

**Note:** The `http://localhost/*` entry in `host_permissions` is required for the dynamic content script registration to work in development. For non-localhost deployments, add the production URL to `host_permissions` in `manifest.json`.

## Tab reuse

When navigating between Docreview and Google Docs, links reuse existing tabs instead of opening new ones. This keeps the user to one Docreview comments tab and one Google Docs tab per document, while still allowing middle-click to force a new tab.

### Two tab-tracking systems

Tab reuse relies on two independent mechanisms that cooperate:

1. **Named window targets** (`src/lib/tab-targets.ts`): The web app uses `<a target="dr-{googleDocId}">` for Docreview comments links and `<a target="doc-{googleDocId}">` for Google Docs links. The browser reuses an existing tab with the same `window.name`. This works for Docreview-to-Docreview links (same origin) and for Google Docs tabs that the web app originally opened (same browsing context group).

2. **Extension tab tracking** (`background.js`): The extension maintains a `docTabMap` (docId -> tabId) in `chrome.storage.session`, and also searches open `docs.google.com` tabs by URL. This is needed because `chrome.tabs.create()` opens tabs outside the web app's browsing context group, so named targets from the web app can't find them.

### Why both are needed

Named targets only find tabs within the same **browsing context group** — windows that have an opener/opened relationship. When the web app opens a Google Doc via `<a target="doc-{id}">`, it's in the group and can be found later by name. But when the extension opens a Google Doc via `chrome.tabs.create()` (e.g., from clicking "Open" on a comment), that tab is outside the group. The web app's `<a target="doc-{id}">` won't find it and would open a duplicate.

The extension bridges this gap via `focusDocTab`: the web app asks the extension "do you know about a tab for this doc?" before falling through to the named target link. The shared helper `findDocTab()` in background.js checks both `docTabMap` and a URL-based search across all `docs.google.com` tabs.

### How it works by scenario

**Docreview comments links** (doc list title, add dialog, bulk edit): Use `commentsTarget(googleDocId)` -> `dr-{id}`. Pure named targets, no extension involvement. Clicking the same doc from different pages reuses the same comments tab.

**Opening Google Docs (no extension)**: Use `docTarget(googleDocId)` -> `doc-{id}`. The `<a target>` link handles tab reuse natively.

**Opening Google Docs (extension available)**: The `handleOpenDocClick()` helper in `bridge-to-extension.ts` intercepts the click, asks the extension to `focusDocTab`, and only falls through to `window.open` with the named target if no tab was found. This handles both directions:
- Doc list opens first, then comments page "Open" -> extension's `findDocTab` finds the tab by URL
- Comments page opens first (via extension), then doc list "Open" -> extension's `focusDocTab` finds it in `docTabMap`

**Comment navigation** (clicking "Open" on a specific comment): The extension's `navigateToComment` finds the tab via `findDocTab`, focuses it, and injects a script to scroll to the comment without reloading. If no tab exists, it creates one with a `?disco=` URL for initial scroll.

### window.name synchronization

The extension sets `window.name = 'doc-{id}'` on Google Docs tabs it tracks (via `setDocTabName`), so that future named-target links from the web app can find them. This is called from `focusDocTab`, `trackDocTab`, `navigateToComment` (new tabs), and the toolbar click handler. The `if (!window.name)` guard avoids overwriting names set by the web app's `<a target>`.

### Key files

| File | Role |
|------|------|
| `src/lib/tab-targets.ts` | Named target helpers: `commentsTarget()`, `docTarget()`, `openCommentsPage()`, `openDocPage()` |
| `src/lib/bridge-to-extension.ts` | `focusDocTab()`, `handleOpenDocClick()`, `navigateToComment()` |
| `src/chrome-extension/background.js` | `findDocTab()`, `setDocTabName()`, `focusDocTab` handler, `navigateToComment()` |

## Comment navigation implementation

Comment navigation works across Google Docs, Sheets, and Slides — they all run on `docs.google.com` and share the same Closure Library component tree and comment DOM structure.

The injected navigation script (`navigateToCommentInPage`) handles several complications:

- **Disco ID discovery**: Comment disco IDs are stored deep in Google's Closure Library component tree under minified property names that change between releases. Instead of hardcoding these names, the script discovers the correct path dynamically by walking the tree and looking for AAAB-pattern ID strings. With 2+ comments, it diffs two items to find paths that differ (per-item ID) vs paths through array indices (shared model). With 1 comment, it finds the shortest non-array path. The discovered path is used for all items within a single navigation call.
- **Anchored comments** (open, with margin highlights): Navigates and closes the comments pane for a clean view.
- **Non-anchored comments** (resolved, unanchored): Opens the comments pane so the comment is visible, then navigates.
- **Suggestions without a disco ID**: Focuses the existing tab without scrolling.
- **Document tab switches**: Clicking a comment on a different document tab rebuilds the stream view DOM. The script clicks once to navigate, waits 300ms for the DOM to settle, then re-finds and clicks again to ensure selection.
- **Fallback**: If the comment can't be found in the component tree (e.g. Google changed their code), falls back to a page reload with `?disco=` in the URL.

See `docs/notes-on-comment-navigation.md` for detailed research notes on the Google Docs DOM structure and the complications encountered during implementation.

## Comment activity auto-sync

When the user acts on a comment in Google Docs (reply, resolve, accept/reject suggestion, new comment), the extension automatically syncs the change back to Docreview's database without requiring a manual Refresh.

### Detection (content.js)

The content script uses event delegation on `mouseup` (capture phase) to detect actions on comment buttons. Google's Closure Library handles these buttons on `mousedown`/`mouseup`, not `click` — the `click` event never fires. Detected buttons:
- `[aria-label="Reply to comment"]` / `[aria-label="Post Comment"]` — Reply or Comment submit button (checked for `jfk-button-disabled` to avoid false positives)
- `[aria-label="Mark as resolved and hide discussion"]` — Resolve button
- `[aria-label="Accept suggestion"]` / `[aria-label="Reject suggestion"]` — Suggestion actions

Also catches `Ctrl+Enter` / `Cmd+Enter` inside `.docos-input-textarea` (keyboard shortcut for submitting replies/comments).

### Waiting for Google to save

After detecting the user's action, the content script doesn't notify immediately — there's a race condition where the Drive API might return stale data if the comment hasn't been persisted yet. Instead, it starts a `MutationObserver` on the comment list (`[role="list"]`) and waits for Google Docs to update the DOM (reply appears, comment removed on resolve, etc.), which confirms the action was saved. A 3-second fallback timeout fires if no mutation occurs (e.g., the action failed silently).

### End-to-end flow

**Step 1 — Detection** (`content.js` on Google Docs page)

`mouseup` listener catches clicks on Reply, Comment, Resolve, Accept, Reject buttons (matched by aria-label). `keydown` listener catches Ctrl+Enter in comment input areas.

**Step 2 — Wait for Google to confirm** (`content.js`)

Starts a `MutationObserver` on the comment list (`[role="list"]`). When the DOM updates (reply appears, comment removed, etc.), Google has saved the change. Sends `commentActivity` message to `background.js`. Fallback: 3s timeout if no mutation fires; 500ms delay if the comment list element isn't found.

**Step 3 — Sync + debounce** (`background.js`, triggered by message from step 2)

First event for a docId: fires `POST /api/docs/sync-comments/{googleDocId}` immediately (leading edge), starts 1s cooldown. Events during cooldown: suppressed, but flagged as pending. After cooldown: fires one more sync only if events arrived during cooldown, to catch changes the leading sync may have missed. Single action = 1 sync. Rapid overlapping actions = 2 syncs (leading + trailing).

**Step 4 — Server sync** (`sync-comments/[googleDocId]/route.ts`)

Looks up doc by Google doc ID, calls `syncComments()` which fetches all comments from Drive API + all suggestions from Docs API, updates database.

**Step 5 — Notify docreview tabs** (`background.js` → `bridge-to-docreview.js` → `bridge-to-extension.ts`)

Background sends `commentSynced` to first open docreview tab via `chrome.tabs.sendMessage`. Bridge content script relays to page via `window.postMessage`. Extension bridge posts to `BroadcastChannel` (using a separate short-lived instance so the receiving tab also gets it — the shared singleton suppresses self-delivery by spec). All docreview tabs receive via `useCrossTabListener` and refetch from database. If no docreview tab is open, nothing to notify — database is already updated for next visit.

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
