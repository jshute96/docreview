The Docreview Chrome extension adds quick-access icons to Google Docs, Drive, and Gmail so you can open documents in Docreview with one click. It also enables smooth in-page comment navigation from Docreview to Google Docs, Sheets, and Slides.

## Installation

[Get the Chrome extension here]({{CHROME_EXTENSION_URL}}).

The extension is installed manually from files:

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (toggle in the top right).
3. Click **Load unpacked** and select the files downloaded above or the `src/chrome-extension` folder from the Docreview source code.

## What it adds

### Link context menu

Right-click any link to a Google Doc or Drive file -- on any web page -- and choose **Open in Docreview** to jump straight to that document.

### Toolbar icon

Click the Docreview extension icon in Chrome's toolbar to open the current page's document in Docreview. This works on Google Docs and Gmail notification pages. On blank pages, it opens Docreview's document list page.

### Google Docs, Sheets, and Slides

A small Docreview icon appears in the document's title bar. Click it to open the document in Docreview -- if it's already tracked, you go to the comment detail page; if not, the Add Document page.

When you add, reply to, resolve, or accept/reject comments in Google Docs, the extension automatically syncs those changes back to Docreview and updates all open Docreview tabs -- no manual refresh needed. This is controlled by the "Notify on comment activity" setting.

On access-denied pages, an "Add in Docreview" link appears so you can track the document even before you have access.

### Google Drive

Docreview icons appear next to file type icons in both list and grid views. Click any icon to open that document in Docreview.

### Gmail

When viewing a Google Docs notification email (comment notification or sharing invitation), a "Open in Docreview" link appears. This extracts the document URL from the email and opens it in Docreview.

## Comment navigation

When viewing a document's comments in Docreview, clicking "Open" on any comment navigates to that comment in Google Docs, Sheets, or Slides without reloading the page. The extension keeps track of which tab has the document open -- the first click opens a new tab, and subsequent clicks reuse it, scrolling to the selected comment instantly. If you open Docreview from a Google Docs tab (via the Docreview icon), that tab is remembered, so clicking "Open" takes you back to the same tab.

This works for both open and resolved comments. For resolved comments, the extension opens the comments pane in Google Docs so the resolved comment is visible.

Without the extension installed, the "Open" buttons still work but they have to reload the page each time, which is slow.

Comment navigation requires the "Enable on Google Docs" option to be turned on in the extension settings.

## Configuration

By default, the extension connects to `http://localhost:3000`. To change this:

1. Right-click the extension icon and select **Options**.
2. Enter your Docreview server URL.
3. Click **Save**.

The options page also has toggles for enabling/disabling the extension on each Google service and comment activity notifications.

The settings sync across your Chrome devices.
