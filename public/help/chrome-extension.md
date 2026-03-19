The Docreview Chrome extension adds quick-access icons to Google Docs, Drive, and Gmail so you can open documents in Docreview with one click.

## Installation

The extension is installed manually from the source code:

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (toggle in the top right).
3. Click **Load unpacked** and select the `src/chrome-extension` folder from the Docreview source code.

## What it adds

### Google Docs, Sheets, and Slides

A small Docreview icon appears in the document's title bar. Click it to open the document in Docreview -- if it's already tracked, you go to the comment detail page; if not, the Add Document page.

On access-denied pages, an "Add in Docreview" link appears so you can track the document even before you have access.

### Google Drive

Docreview icons appear next to file type icons in both list and grid views. Click any icon to open that document in Docreview.

### Gmail

When viewing a Google Docs notification email (comment notification or sharing invitation), a "Open in Docreview" link appears. This extracts the document URL from the email and opens it in Docreview.

## Toolbar icon

Click the Docreview extension icon in Chrome's toolbar to open the current page's document in Docreview. This works on Google Docs, Sheets, Slides, and Gmail notification pages.

Right-click the toolbar icon for additional options:
- **Open Docreview** -- Go to your document list.
- **Open Add Document** -- Go directly to the Add Document page.
- **Options** -- Configure the Docreview server URL.

## Configuration

By default, the extension connects to `http://localhost:3000`. To change this:

1. Right-click the extension icon and select **Options**.
2. Enter your Docreview server URL.
3. Click **Save**.

The setting syncs across your Chrome devices.
