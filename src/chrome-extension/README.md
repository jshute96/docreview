# Docreview Chrome Extension

Adds Docreview integration to Google Docs, Google Drive, and Gmail.

## What it does

### Google Docs
A Docreview icon appears in the document titlebar (next to the sharing badges). Click it to open the document in Docreview.

### Google Drive
Docreview icons appear next to file type icons in both list and grid views. Click any icon to open that file in Docreview.

### Gmail
For Docs notification emails (comments, suggestions, sharing), an "Open in Docreview" link appears inside the email. Click it to open the referenced document in Docreview.

### Toolbar icon
Click the Docreview icon in Chrome's toolbar to open the current page in Docreview:
- On Google Docs/Sheets/Slides, opens the current document directly.
- On Gmail, finds the document link in the current email and opens it. Shows an alert if no document is found or if multiple different documents are linked.

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

**`manifest.json`** — Manifest V3 configuration. Declares permissions (`storage`, `activeTab`, `contextMenus`, `scripting`), host permissions for the three Google domains, and registers the content script and service worker.

**`content.js`** — Runs on Google Docs, Drive, and Gmail pages. Injects Docreview icons by manipulating the DOM. Uses MutationObservers to handle dynamically loaded content (Google Workspace apps load UI elements after the initial page load). Adapted from the bookmarklet in `src/bookmarklet/bookmarklet-source.js` with two key changes: the base URL comes from `chrome.storage.sync`, and the Gmail link resolves its target URL at click time rather than injection time (to handle Gmail's SPA navigation correctly).

**`background.js`** — Service worker that handles toolbar clicks, context menu actions, and messages from the content script. For Gmail, it uses `chrome.scripting.executeScript` with `allFrames: true` to search all frames (including sandboxed AMP iframes that content scripts can't access) for document URLs. Deduplicates by document ID since notification emails contain multiple links to the same document.

**`options.html` + `options.js`** — Simple settings page for configuring the Docreview server URL, stored in `chrome.storage.sync`.

**`defaults.js`** — Shared default configuration (base URL) loaded by all other scripts.

**`icons/`** — 16/48/128px PNGs converted from `public/docreview.svg`. If the source SVG changes, regenerate with:
```bash
for size in 16 48 128; do
  convert -background none -resize ${size}x${size} public/docreview.svg src/chrome-extension/icons/icon${size}.png
done
```
