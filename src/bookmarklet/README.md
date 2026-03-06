# Docreview Bookmarklet

A bookmarklet that adds a Docreview icon to Google Workspace apps for quick access.

## User Experience

The bookmarklet injects a violet Docreview icon into the following locations:

1.  **Google Docs/Sheets/Slides:** In the titlebar, directly to the left of the document name.
2.  **Google Drive:** In the file list (List/Search view) and grid view (Boxes), next to the file type icon.

### Interaction
- **Clicking the icon:** Opens the document in a new Docreview tab.
  - If the doc is already tracked, it goes to the **Comments view**.
  - If it's a new doc, it goes to the **Add Document** page.
- **Dynamic Views:** On Google Drive, the bookmarklet automatically adds icons to new files as you scroll or navigate.

### Installation
1. Start Docreview: `npm run dev`.
2. In the Docreview inbox view, click the **Menu** icon (three horizontal lines) in the top-right.
3. Select **Bookmarklet page** (this opens `http://localhost:3000/bookmarklet`).
4. Drag the **Docreview links** button to your bookmarks bar.

---

## Technical Architecture

To ensure the bookmarklet is maintainable and robust against complex SPAs like Google Drive, it follows a structured build pipeline and aggressive event handling pattern.

### Build Pipeline
1.  **Source:** `src/bookmarklet/bookmarklet-source.js` is the **source of truth**. It contains clean, documented JavaScript.
2.  **Minification:** `scripts/build-bookmarklet.mjs` minifies the source and handles double-escaping for regex and backslashes.
3.  **App Integration:** 
    *   `src/bookmarklet/bookmarklet-code.ts` (generated) exports the minified string as a constant.
    *   `src/app/bookmarklet/` contains the Next.js UI which imports this code.

### Google Drive Implementation
Google Drive is a single-page application that dynamically renders and clears its DOM.
- **Persistence:** The bookmarklet uses a `MutationObserver` and a 2-second background poll to re-scan the page and re-inject icons when Drive clears them.
- **Targeting:**
  - **List/Search View:** Scans by row (`[role="row"]`) and targets only the **first** icon container (`.rxUYqf` or `.qHF2df`) in that row. This ensures the icon only appears in the "Name" column.
  - **Grid View:** Targets `.qHF2df` containers and retrieves IDs from the parent `.RlzxUb`.
- **Identification:** Validates document IDs (length > 20) to filter out folders and navigation items.

### Event Interception
Google Drive uses aggressive event listeners to handle row selection. To ensure our links work, the bookmarklet:
1. Installs **capturing-phase event listeners** (`click`, `mousedown`, `mouseup`) directly on the injected Docreview icon.
2. Calls `stopImmediatePropagation()` to kill the event before Drive's listeners can see it.
3. Manually triggers `window.open()`.

### Idempotency
- Uses a global `window._dr` object to track state.
- Re-running the bookmarklet disconnects old observers, clears old intervals, and wipes internal `data-dr-in` markers to allow a fresh scan.

### Building
Building is **not automatic**. After editing `bookmarklet-source.js`, run:
```bash
npm run build:bookmarklet
```
(This is also included in the main `npm run build` script).

### Limitations
- **Manual Activation:** You must click the bookmarklet once per session/refresh.
- **Browser Security:** Uses a React `ref` bypass to allow `javascript:` URLs in the install UI.
- **Icons:** Browsers do not support custom favicons for bookmarklet links in the bookmarks bar.
- **Brittle Selectors:** Injection relies on Google's internal CSS class names, which may change.
