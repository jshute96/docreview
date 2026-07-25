# Chrome Extension — Console Debugging Commands

Runnable commands for debugging the Chrome extension.

## Three consoles

The extension spans three separate JavaScript contexts, each with its own
DevTools console. Knowing which console to check is the first step in debugging.

### Service worker console

Open via chrome://extensions → Inspect views: service worker.

This is the extension's background context. All cross-tab coordination happens
here — message routing, comment sync dispatching, tab tracking, and content
script injection. Log lines use the `[background]` prefix.

**What you'll see here:**
- `[background] comment sync succeeded for ...` — server-side sync results with timing
- `[background] sendMessage(commentSynced) failed ...` — delivery failures when notifying docreview tabs
- `[background] forwarding docReady/commentSelection to N tab(s)` — message broadcasts
- `[background] re-injected ... scripts into tab ...` — content script re-injection on extension reload
- `[background] navigateToComment result: ...` — comment navigation outcomes
- Tab tracking updates (`trackDocTab`, `focusDocTab`)

**What you can do here:** All `chrome.*` APIs are available — query tabs, inspect
storage, send test messages, re-inject scripts. Most of the runnable commands in
this document are for this console.

### Google Docs page console

Open via right-click → Inspect on any Google Docs/Sheets/Slides page, then the
Console tab.

Two sets of code run here:
1. **Content scripts** (`content.js`, `content-comments.js`) in the isolated
   world — detect comment activity, relay selection changes, send `docReady`.
   Log lines use the `[docreview]` prefix.
2. **Injected page scripts** (`background-injected.js` functions) in the MAIN
   world — disco ID helpers, comment extraction, navigation. Log lines use
   `[docreview-extract]` or `[docreview-nav]`.

**What you'll see here:**
- `[docreview] comment action confirmed, notifying: reply ...` — detected user action
- `[docreview] doc ready (stream view populated): ...` — stream view loaded
- `[docreview] comment selected: AAAB` / `comment deselected` — selection tracking
- `[docreview] extension context invalidated, skipping ...` — orphaned content script (extension was reloaded, tab needs re-injection)
- `[docreview-extract] disco ID: AAAB` — pre-extraction of comment IDs
- `[docreview-nav] navigating to ...` — in-page comment navigation

**What you can do here:** The injected helpers are callable from this console:
`listComments()`, `getComments()`, `getSuggestions()`, `getActiveCommentId()`,
`loadAllComments()` (see "Listing comments and disco IDs" section below).

### Docreview page console

Open via right-click → Inspect on the Docreview web app, then the Console tab.

Two sets of code run here:
1. **Bridge content script** (`bridge-to-docreview.js`) in the isolated world —
   relays messages between the web app and the background worker. Log lines use
   the `[bridge-to-docreview]` prefix.
2. **Web app** (React/Next.js) in the page world — sends requests to the
   extension via `bridge-to-extension.ts`, receives notifications. Log lines use
   the `[extension]` or `[bridge-to-extension]` prefix.

**What you'll see here:**
- `[bridge-to-docreview] relaying commentSynced for ...` — sync notification arrived from background
- `[bridge-to-extension] commentSynced received, broadcasting for ...` — web app broadcasting to other tabs
- `[bridge-to-extension] docReady received for ...` — doc stream view ready notification
- `[extension] Detected: {version, baseUrl, ...}` — successful ping on page load
- `[extension] Not detected` — extension not available (not installed, bridge not injected)
- `[extension] getSuggestion: AAAB found` — suggestion fetched from doc tab

**What you can do here:** The web app's extension bridge functions aren't
directly callable from the console (they're module-scoped), but you can test the
bridge manually with `window.postMessage`:
```js
// Test if the bridge is alive
window.postMessage({source: 'docreview-page', id: 9999, type: 'ping'}, '*')
// Watch for: {source: 'docreview-extension', id: 9999, response: {version: ...}}
```

## Identifying tabs and windows by ID

Error messages and logs often include a tab ID (e.g., `tab 738130815`). To investigate:

```js
// Look up a tab by ID — shows URL, title, status, windowId
chrome.tabs.get(738130815, t => console.log(t))

// Switch to a tab (and its window)
chrome.tabs.update(738130815, {active: true}, t => chrome.windows.update(t.windowId, {focused: true}))

// List all Google Docs tabs
chrome.tabs.query({url: 'https://docs.google.com/*'}, tabs => tabs.forEach(t => console.log(t.id, t.title, t.status)))

// List all docreview tabs
chrome.tabs.query({url: 'http://localhost:3000/*'}, tabs => tabs.forEach(t => console.log(t.id, t.title, t.status)))

// List all windows
chrome.windows.getAll({populate: false}, ws => ws.forEach(w => console.log('window', w.id, w.type, w.state)))
```

## Doc tab tracking state

```js
// Show docId → tabId map (persisted in session storage)
chrome.storage.session.get(null, items => console.log(items))

// Find which tab the extension thinks has a specific doc open
chrome.storage.session.get('docTab:1Vix-dxl6MscHIVHQuoJ0IluoxemDZWj1ajM0ucIE27g', v => console.log(v))
```

## Extension settings

```js
// Show all synced settings (baseUrl, feature toggles, resolveHosts)
chrome.storage.sync.get(null, items => console.log(items))
```

## Listing comments and disco IDs (Google Docs page console)

These are available in the **Google Docs page console** (not the service worker console), injected at page load by `background-injected.js`:

```js
// List all visible comments/suggestions with disco IDs
listComments()

// Full comment details (status, author, replies, tabName)
getComments()

// Single comment by disco ID
getComment('AAAB')

// Full suggestion details (type, old/new text, status, replies)
getSuggestions()

// Single suggestion by disco ID
getSuggestion('AAAC')

// Both, in the shape sent to the web app. `missingIdCount` counts list items whose
// disco ID couldn't be extracted — they're dropped, never given a placeholder.
// A non-zero count means the scrape is incomplete (usually because the pane's
// click handlers weren't wired up yet); the async
// __docreviewDisco.fetchCommentsAndSuggestions() retries before reporting.
__docreviewDisco.getCommentsAndSuggestions()

// Which build of the page helpers this tab is running. If it's behind the
// extension's current VERSION (see injectDiscoIdHelpers), the next MAIN-world
// call re-installs them — useful when a method seems to be "missing" on a tab
// that was open across an extension reload.
__docreviewDisco.version

// Currently selected comment's disco ID
getActiveCommentId()

// Ensure all comments are loaded (opens pane if needed)
loadAllComments()
```

## Testing message delivery

```js
// Send a test commentSynced message to all docreview tabs
chrome.tabs.query({url: 'http://localhost:3000/*'}, tabs => {
  tabs.forEach(t => {
    chrome.tabs.sendMessage(t.id, {type: 'commentSynced', docId: 'test'}, r => {
      console.log('tab', t.id, chrome.runtime.lastError ? 'FAILED: ' + chrome.runtime.lastError.message : 'OK')
    })
  })
})

// Check which registered content scripts exist (including dynamic bridge)
chrome.scripting.getRegisteredContentScripts().then(cs => console.log(cs))

// Manually re-inject content scripts into a specific tab
// (check manifest.json content_scripts[0].js for current file list)
chrome.scripting.executeScript({target: {tabId: 738130815}, files: ['defaults.js', 'content-comments.js', 'content.js']}).then(() => console.log('injected'))
```
