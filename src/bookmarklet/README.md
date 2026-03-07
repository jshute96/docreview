# Docreview Bookmarklets

Two bookmarklets for quick access to Docreview from Google Workspace.

## Add Docreview links

Injects a violet Docreview icon into the following locations:

1.  **Google Docs/Sheets/Slides:** In the titlebar, directly to the left of the document name.
2.  **Google Drive:** In the file list (List/Search view) and grid view (Boxes), next to the file type icon.

- **Clicking the icon:** Opens the document in a new Docreview tab.
  - If the doc is already tracked, it goes to the **Comments view**.
  - If it's a new doc, it goes to the **Add Document** page.
- **Dynamic Views:** On Google Drive, the bookmarklet automatically adds icons to new files as you scroll or navigate.

## Open in Docreview

A simpler bookmarklet — click it while viewing a Google Doc, Sheet, or Slides to open the document directly in Docreview. Shows an error if the current page is not a supported document.

## Installation
1. Start Docreview: `npm run dev`.
2. In the Docreview inbox view, click the **Menu** icon (three horizontal lines) in the top-right.
3. Select **Bookmarklet page** (this opens `http://localhost:3000/bookmarklet`).
4. Drag either bookmarklet button to your bookmarks bar.

---

## Technical Architecture

To ensure the bookmarklet is maintainable and robust against complex SPAs like Google Drive, it follows a structured build pipeline and aggressive event handling pattern.

### Build Pipeline
1.  **Source files:** `bookmarklet-source.js` (Add Docreview links) and `open-in-docreview-source.js` (Open in Docreview) are the **sources of truth**. They contain clean, documented JavaScript.
2.  **Minification:** `scripts/build-bookmarklet.mjs` minifies each source and handles double-escaping for regex and backslashes.
3.  **App Integration:**
    *   `bookmarklet-code.ts` and `open-in-docreview-code.ts` (generated) export the minified strings as constants.
    *   `src/app/bookmarklet/` contains the Next.js UI which imports both.

### Google Drive Implementation
Google Drive is a single-page application that dynamically renders and clears its DOM.
- **Persistence:** The bookmarklet uses a `MutationObserver` and a 1-second background poll to re-scan the page and re-inject icons when Drive clears them.
- **Robust Targeting:**
  - **Selectors:** Uses ARIA roles (`[role="row"]`, `[role="gridcell"]`) and stable data attributes (`[data-column-id="16"]` for the Name column) rather than obfuscated CSS classes.
  - **Heuristic:** Inside a file row or grid item, it searches for the first `svg` or `img` to use as an anchor point for injection.
- **Identification:** Validates document IDs (length > 20) to filter out folders and navigation items.

### Event Interception
Google Drive uses aggressive event listeners to handle row selection. To ensure our links work, the bookmarklet:
1. Installs **capturing-phase event listeners** (`click`, `mousedown`, `mouseup`) directly on the injected Docreview icon elements.
2. Calls `stopImmediatePropagation()` to kill the event before Drive's listeners can see it.
3. Manually triggers `window.open()`.

### Idempotency
- Uses a global `window._dr` object to track state.
- Re-running the bookmarklet disconnects old observers, clears old intervals, and allows a fresh scan by checking for the absence of `.dr-link` elements.

### Building
Building is **not automatic**. After editing either source file, run:
```bash
npm run build:bookmarklet
```
(This is also included in the main `npm run build` script).

### Changing the host
When installed via the `/bookmarklet` page, the bookmarklet **automatically points to the server it was installed from** (using `window.location.origin` at runtime). No manual configuration is required for standard use.

### Limitations
- **Manual Activation:** You must click the bookmarklet once per session/refresh.
- **Browser Security:** Uses a React `ref` bypass to allow `javascript:` URLs in the install UI.
- **Icons:** Browsers do not support custom favicons for bookmarklet links in the bookmarks bar.
- **Implementation Stability:** While improved with ARIA roles, injection still relies on Google's internal DOM structure (like column IDs), which may change.
