# Docreview Chrome Extension

An optional Chrome extension that adds improved integration with Google Docs, Google Drive, and Gmail.

Docreview works without it, but the extension adds links to open Docreview easily, and provides smoother navigation from Docreview to comments in Docs, Sheets, and Slides.

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
Click the Docreview icon in Chrome's toolbar:
- On a blank or new tab, opens Docreview directly.
- On Google Docs/Sheets/Slides, opens the current document in Docreview.
- On Gmail, finds the document link in the current email and opens it. Shows an alert if no document is found or if multiple different documents are linked.

Right-click the toolbar icon for:
- **Open Docreview** — opens the Docreview home page
- **Open Add Document** — opens the Docreview add document page
- **Options** — configure the Docreview server URL and feature toggles

### Shortened URL resolution
When adding a document via a shortened link (e.g. `go/my-doc`), the server first attempts to follow the redirect itself. If the server can't resolve it (e.g. the shortener requires browser cookies for authentication), and the extension's redirect-link resolver is enabled, the extension resolves the redirect by opening the URL in a background tab (which has the user's cookies). If the redirect lands on a Google Docs URL, it's captured and used for validation. The background tab is closed automatically once the redirect completes or fails. This feature is disabled by default in the extension settings.

### In-page comment navigation
When viewing a document's comments in Docreview, clicking "Open" on a comment navigates to that comment in the Google Docs, Sheets, or Slides tab without reloading the page. The extension tracks which Chrome tab has each document open — the first click opens a new tab, and subsequent clicks reuse it. If you open Docreview from a Google Docs tab (via the titlebar icon or toolbar icon), that tab is automatically tracked, so clicking "Open" in Docreview reuses the original tab instead of opening a new one.

This feature requires the "Enable on Google Docs" option to be on in the extension settings. When disabled, "Open" links fall back to page-reload navigation.

See `docs/notes-on-comment-navigation.md` for detailed research notes on the Google Docs DOM structure.

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

The options page also has toggles for enabling/disabling the extension on each Google service (Docs, Drive, Gmail) and the redirect-link resolver.

## Design & implementation

See `docs/chrome-extension.md` for design and implementation details.
