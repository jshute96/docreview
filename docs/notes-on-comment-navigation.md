# Notes on Google Docs Comment Navigation

Working notes on navigating between comments in an already-open Google Docs page, without triggering a full page reload.

## Goal

Docreview comments page open in one window, Google Docs in another. Clicking a comment in Docreview scrolls the Google Doc to that comment's location. Currently, Docreview's "Open" links use `?disco=<id>` URLs which reload the page — slow and jarring. Also, `disco=` doesn't work for suggestions (only comments).

## What we found

### The comments pane DOM

- The comments pane is a `<div id="docos-stream-view" role="list">` in the main frame (not an iframe).
- Each comment/suggestion is a `<div role="listitem">` with an `aria-label` like `"Comments dialog. Open comment. Author Jeff Shute. 4 replies. 0 new replies."`.
- "Docos" is Google's internal name for the Docs commenting system — all comment CSS classes use the `docos-` prefix.
- The document text itself is **canvas-rendered** — no text content in the DOM. Only the comments pane has accessible text.

### Clicking a listitem navigates to the comment

Calling `.click()` on a listitem in `#docos-stream-view`:
1. Scrolls the document to the commented/suggested text
2. Highlights the text (orange for active, yellow for inactive)
3. Expands the comment thread in the pane
4. Updates the URL with `?disco=<AAAB_id>` (but only on the first click — subsequent clicks navigate visually without updating the URL)

This is the key mechanism — it works for both comments and suggestions, with no page reload. It also works for hidden/off-screen listitems and even resolved comments cached in the DOM.

### Disco IDs are in the Closure component tree (not the DOM)

The `AAAB...` disco IDs are **not in the DOM** — not in HTML attributes, data attributes, element IDs, or any accessible JS property on the elements. They are stored deep in Google's Closure Library component tree, accessible via a specific path from each listitem element:

```javascript
// Get the closure_lm key (name varies per page load, e.g. "closure_lm_501193")
const lmKey = Object.keys(listitem).find(k => k.startsWith('closure_lm'));

// The disco ID for this specific comment:
const discoId = listitem[lmKey].listeners.click[0].Yd.Ai;

// The full array of all comment models (from any listitem):
const allComments = listitem[lmKey].listeners.click[0].Yd.t3b.qq;
// Each entry: allComments[i].Ai = disco ID for that comment
```

**Property names are minified** (`Yd`, `Ai`, `t3b`, `qq`) and could change between Google Docs releases. The structural pattern (closure_lm → click listener → model object with ID) should be more stable than the specific property names.

#### Other useful properties in the comment model

Each comment object in `t3b.qq` has:
- **`Ai`** — the `AAAB...` disco ID
- **`qq`** — array of replies. Each reply has:
  - `Ai` — reply ID (`"root"` for the first reply, `AAAB...` for subsequent)
  - `W` — parent comment ID
  - `Te` — author name (e.g., "Jeff Shute")
- **`Aa.Ai`** — same as the top-level `Ai` (redundant)
- **`zg`** — boolean, appears to indicate "is new/unread"
- **`ma`** — boolean, `true` only on the currently active/selected comment

Per-listitem model (via `click[0].Yd`):
- **`Ai`** — disco ID for the comment this listitem represents
- **`t3b.qq`** — reference to the shared array of all comment models

#### How to extract the full ID mapping

```javascript
function getCommentIdMap() {
  const items = document.querySelectorAll('#docos-stream-view [role="listitem"]');
  const map = [];
  for (const item of items) {
    const lmKey = Object.keys(item).find(k => k.startsWith('closure_lm'));
    let discoId = null;
    try { discoId = item[lmKey].listeners.click[0].Yd.Ai; } catch(e) {}
    const ariaLabel = item.getAttribute('aria-label') || '';
    const resolved = item.textContent.includes('Resolved');
    map.push({ element: item, discoId, resolved, ariaLabel });
  }
  return map;
}
```

#### How to navigate to a comment by disco ID

```javascript
function navigateToComment(discoId) {
  const items = document.querySelectorAll('#docos-stream-view [role="listitem"]');
  for (const item of items) {
    const lmKey = Object.keys(item).find(k => k.startsWith('closure_lm'));
    try {
      if (item[lmKey].listeners.click[0].Yd.Ai === discoId) {
        item.click(); // scrolls doc, activates comment, no reload
        return true;
      }
    } catch(e) {}
  }
  return false;
}
```

### "Get link to this comment" confirms the IDs

The 3-dots menu → "Get link to this comment" copies a URL with the `AAAB...` disco ID to the clipboard. Key facts:
- **Zero network requests** — the link is constructed entirely client-side from the in-memory model
- Works for both comments and suggestions (suggestions get `AAAB...` IDs too, different from the `suggest.*` IDs used by the Drive API)
- The clipboard can be read via `navigator.clipboard.readText()` after triggering the menu action
- Google Docs uses `document.execCommand('copy')` internally — monkey-patching `navigator.clipboard.writeText` does not intercept it

### Accept/reject suggestion behavior

- Accept/reject buttons are `<div role="button">` elements with classes `docos-accept-suggestion` / `docos-reject-suggestion`
- No `href`, `onclick`, or `jsaction` attributes — entirely wired through Closure's internal event system
- Clicking accept/reject sends the mutation through a **pre-existing persistent connection** (WebSocket or long-poll channel opened at page load), not through fetch or XHR
- The comment ID is resolved in-memory from the Closure component tree — not passed as a visible parameter

### DOM behavior and complications

The stream view (`#docos-stream-view`) contains comment listitems in two forms:
- **Anchored** (`docos-anchoreddocoview`): Open comments with a highlight in the document margin. Visible without the comments pane.
- **Non-anchored / Stream** (`docos-streamdocoview`): Resolved comments, unanchored comments, and comments loaded by the comments pane. Only visible when the pane is open.

**DOM rebuilding:** The stream view DOM is rebuilt when:
- The comments pane is opened or closed (item count changes, e.g. 31 → 44)
- A document tab switch occurs (clicking a comment on a different tab)
- A comment is resolved or accepted/rejected

This means **item references become stale** after any of these events. Code must re-query the DOM after triggering any action that might rebuild it.

**Duplicate entries:** The same disco ID can appear in both an anchored and a non-anchored entry simultaneously. When searching, prefer the anchored entry (it provides the best visual experience — margin highlight without the pane).

**Lazy loading:** On initial page load, only open anchored comments are in the DOM. Resolved and unanchored comments are loaded when the comments pane is opened. Once loaded, they persist as hidden DOM elements even after the pane is closed.

**What we learned about reliable navigation:**
- A single `.click()` on a listitem may not reliably select the comment, especially if the click triggers a document tab switch that rebuilds the DOM
- The solution is click-then-refind-then-click: click once to navigate/switch tabs, wait for the DOM to settle (300ms), re-query to get a fresh item reference, then click again to ensure selection
- Pane state should be determined from the final DOM state (anchored vs non-anchored), not from Docreview's resolved flag, since the DB may be stale

**What doesn't work for comment interaction:**
- `element.click()` (bare) doesn't work for Google Docs UI buttons — they need `fullClick` (mousedown+mouseup+click sequence)
- `.click()` *does* work for comment listitems (they respond to bare click)
- Deselecting comments via synthetic events is unreliable — Google Docs uses canvas rendering and doesn't respond to synthetic mouse events on the content area

### Anchored vs non-anchored detection

```javascript
// Anchored: has margin highlight, visible without comments pane
item.classList.contains('docos-anchoreddocoview')

// Non-anchored: resolved, unanchored, or stream-only — needs pane to be visible
item.classList.contains('docos-streamdocoview')
```

### Resolved comment detection

Resolved comments can be identified by:
- `aria-label` contains `"Resolved comment"` (vs `"Open comment"`)
- `textContent` starts with `"Resolved"`
- They are always non-anchored (`docos-streamdocoview`)
- The `t3b.qq` model array does **not** include resolved comments — only the DOM elements remain

### ID systems

There are two unrelated ID systems for the same comment:

| System | Comment example | Suggestion example | Source |
|--------|-----------------|--------------------|--------|
| Drive API / Docreview | `AAAB1agdt2A` | `suggest.pdvnqr4z4qm3` | Google Drive API, stored in Docreview DB |
| Gmail notification disco | `AAAB1agdt2A` | `AAAB1agdt2E` | Gmail notification email URLs |
| "Get link" disco | `AAAB1agdt2A` | `AAAB1agdt2I` (different!) | Google Docs "Get link to this comment" |

- Comments use the same `AAAB...` ID across all systems
- Suggestions have **different IDs** in each system — no known way to translate between them

### What doesn't work for in-page navigation

- Setting `location.hash = '#disco=...'` — Google Docs ignores hash changes
- `history.replaceState` with `?disco=...` + dispatching `popstate` — Google Docs doesn't watch for URL changes
- Clicking highlighted text in the document body — places the editing cursor, doesn't select the comment
- Searching `window` globals at depth 6 for AAAB strings — returns nothing (the IDs are deeper in the Closure tree, at depth 7-10)
- Playwright's `.click()` on hidden/off-screen elements fails with visibility check — must use `element.click()` via `page.evaluate()` instead

### Opening and closing the comments pane programmatically

The "Show all comments" button in the toolbar (`[aria-label*="Show all comments"]`) toggles the comments pane. When open, the pane appears as a `.docs-docos-activity-sidebar` element (one of several `[role="complementary"]` elements on the page — must use the specific class).

**Important:** Google Docs buttons require a full mousedown+mouseup+click event sequence. A bare `.click()` is ignored by the Closure event system:

```javascript
function fullClick(el) {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}
```

**Opening the pane:**
- `fullClick()` on the "Show all comments" button
- Playwright's native `.click()` also works

**Closing the pane:**
- `fullClick()` on the "Close" button inside `.docs-docos-activity-sidebar`
- Playwright's native `.click()` on the "Show all comments" button also works

**Navigation with the pane open:**
- Clicking a comment listitem (via JS `.click()`) while the pane is open scrolls the document AND focuses the comment in the side panel — the best user experience
- For resolved comments, the pane scrolls to show the resolved comment and opens the "re-open discussion" input
- The comment gets the `[active]` state in the pane

### Other navigation methods

- Keyboard: Ctrl+Alt+Shift+A opens the comments list. Arrow keys navigate. But no way to jump to a specific comment by ID.
- The "Show all comments" button (in the toolbar) toggles the comments pane open/closed.
- The comments pane has "All comments" and "For you" tabs, plus type/tab filters.

## Implementation: Chrome extension in-page navigation

The Docreview Chrome extension (version 2+) implements in-page comment navigation. When the user clicks "Open" on a comment in Docreview, the extension navigates to the comment in an already-open Google Docs tab without reloading.

### Architecture

1. **Docreview web app** (`comment-row.tsx`, `doc-detail.tsx`): Intercepts "Open" clicks when the extension is detected (version >= 2). Sends `navigateToComment` message via `extension-bridge.ts`.
2. **Bridge** (`docreview-bridge.js`): Relays postMessage to the background worker.
3. **Background worker** (`background.js`): Tracks which Chrome tab has which Google Doc (persisted in `chrome.storage.session`). If a tab exists, injects the navigation script via `chrome.scripting.executeScript` in `MAIN` world. If not, opens a new tab with `?disco=` URL.
4. **Injected script** (`navigateToCommentInPage`): Finds the comment by disco ID in the Closure component tree and clicks it.

### Tab tracking

- `docTabs` map (docId → tabId) persisted in `chrome.storage.session` to survive MV3 service worker restarts
- First click opens a new tab with `?disco=` URL and tracks it
- Subsequent clicks reuse the tracked tab
- Cleaned up on tab close or navigation away from the doc

### Navigation flow (injected script)

```
1. Find the comment listitem by disco ID in the stream view
   - Prefer anchored entries (docos-anchoreddocoview) over non-anchored
2. If not found, open the comments pane (loads resolved/unanchored) and retry
3. If still not found, fall back to page reload with ?disco= URL
4. Click the item to navigate (may trigger a document tab switch)
5. Wait 300ms for DOM to settle after potential tab switch
6. Re-find and click again to ensure selection with fresh DOM
7. Set pane state: close for anchored comments, open for non-anchored
```

The click-then-refind-then-click pattern is necessary because clicking a comment can switch document tabs, which rebuilds the entire stream view DOM. The initial click navigates but may not select; the second click with a fresh DOM reference ensures selection.

### Pane management

The comments pane state is determined from the doc's DOM (anchored vs non-anchored), not from Docreview's `resolved` flag in the database. This handles cases where the resolved state is stale.

- **Anchored comments** (`docos-anchoreddocoview`): Have margin highlights. Pane is closed after navigation for a clean view.
- **Non-anchored comments** (`docos-streamdocoview`): Resolved, unanchored, or comments on other document tabs. Pane is opened/kept open so the comment is visible.

### Suggestions without disco IDs

Some suggestions only have `suggest.*` IDs (not `AAAB...` disco IDs). When there's no disco ID, the extension just focuses the existing tab without scrolling, reusing the same tab rather than opening a new one.

### Fallback behavior

- If the Closure tree extraction fails to find the comment, falls back to reloading with `?disco=` URL
- If the extension isn't installed, the `<a href>` link with `target="docreview-doc"` works as before
- If script injection fails, falls back to navigating the tab to the `?disco=` URL
