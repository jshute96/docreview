# Notes on Google Docs Comment Navigation

Working notes on navigating between comments in an already-open Google Docs page, without triggering a full page reload.

## Goal

Docreview comments page open in one window, Google Docs in another. Clicking a comment in Docreview scrolls the Google Doc to that comment's location. Currently, Docreview's "Open" links use `?disco=<id>` URLs which reload the page — slow and jarring. Also, `disco=` doesn't work for suggestions (only comments).

## What we found

### The comments pane DOM

- The comments pane is a `<div id="docos-stream-view" role="list">` in the main frame (not an iframe).
- Each comment/suggestion is a `<div role="listitem">` with an `aria-label` like `"Comments dialog. Open comment. Author Jeff Shute. 4 replies. 0 new replies."`.
- "Docos" is Google's internal name for the Docs commenting system — all comment CSS classes use the `docos-` prefix.

### Clicking a listitem navigates to the comment

Calling `.click()` on a listitem in `#docos-stream-view`:
1. Scrolls the document to the commented/suggested text
2. Highlights the text (orange for active, yellow for inactive)
3. Expands the comment thread in the pane
4. Updates the URL with `?disco=<AAAB_id>` (but only on the first click — subsequent clicks navigate visually without updating the URL)

This is the key mechanism — it works for both comments and suggestions, with no page reload.

### No comment IDs in the DOM

The listitems have **no data attributes, IDs, or properties** containing the `AAAB...` or `suggest.*` comment IDs. We checked:
- All HTML attributes and data attributes on listitems and their children
- Google Closure Library properties (`closure_lm_*`, `__jsaction`)
- All `window` global properties
- The `docos_ls` global object

The only identifiers on listitems are the aria-label text content (author name, reply count, quoted text snippet like "· Eawg").

### "Get link to this comment" is client-side

The 3-dots menu → "Get link to this comment" copies a URL with the `AAAB...` disco ID to the clipboard. Key facts:
- **Zero network requests** — the link is constructed entirely client-side
- Works for both comments and suggestions (suggestions get `AAAB...` IDs too, different from the `suggest.*` IDs used by the Drive API)
- Google Docs must have an internal mapping from listitem → disco ID, but it's not exposed in any accessible JS global

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

### Other navigation methods

- Keyboard: Ctrl+Alt+Shift+A opens the comments list. Arrow keys navigate. But no way to jump to a specific comment by ID.
- The "Show all comments" button (in the toolbar) toggles the comments pane open/closed.
- The comments pane has "All comments" and "For you" tabs, plus type/tab filters.

## Possible approaches (not yet implemented)

### Bookmarklet + postMessage

1. A bookmarklet on Google Docs listens for `postMessage` events
2. Docreview uses `window.open('', 'docreview-doc')` to get the Google Docs window reference
3. Docreview sends `postMessage({navigateTo: ...})` with the comment ID
4. The bookmarklet finds the right listitem and clicks it

**Challenge:** Finding the right listitem given a comment ID. Options:
- Match by content (quoted text from aria-label, author, reply count) — fragile but workable for comments
- Build a mapping at init by triggering "Get link" on each comment and reading the clipboard — works but janky
- Find Google's internal Closure function that maps comments to IDs — cleanest but requires reverse-engineering minified code

### Chrome extension

A content script on both pages could bridge the communication without needing `postMessage` or window references. More reliable but heavier to set up.

### For suggestions specifically

Since suggestion IDs differ between Drive API (`suggest.*`) and Google Docs (`AAAB...`), content-matching may be the only viable approach. Match on the suggestion action text (e.g., `"Replace: "Ga" with "gew""`) which appears in the aria-label.
