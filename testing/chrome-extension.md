# Chrome Extension Test Cases

> **Automation status:** Test cases marked **[auto]** are covered by the Playwright
> DOM snapshot tests in `content-script.spec.ts` (`npm run test:e2e`). Cases marked
> **[manual]** require the real extension loaded in Chrome and are not yet automated.
> See `testing/README.md` for how the automated tests work.

Tests reference CSS selectors like `#dr-badge` and `.dr-link` — these are IDs and classes defined in the content script source code. Read the source files to understand what they are and how the idempotency guards work.

Read `src/chrome-extension/README.md` for expected user-facing behavior.

When referencing a test, use the format `testing/chrome-extension.md:LINE` "Test Name" (e.g., `testing/chrome-extension.md:29` "Google Docs — fresh page").

## Setup

1. Install the Chrome extension from `src/chrome-extension/` (load unpacked in `chrome://extensions`).
2. Configure the extension's base URL to `http://localhost:3000` via the options page.
3. Open the Docreview docs page at `http://localhost:3000/docs`.
4. From the docs list, click "Open" on a Google Doc to open it in Google Docs. (Look at the file type icon to find a Doc vs. Sheets vs. Slides if a specific type is needed.)
5. Open Google Drive at `https://drive.google.com` in another tab.

## Content script icon injection

Source: `src/chrome-extension/content.js`

### Google Docs — fresh page [auto]

1. Navigate to a Google Docs document.
2. Verify clean state: no `#dr-badge`, no `.dr-link` elements.
3. Wait for the content script to inject (should happen automatically on page load).
4. **Expect**: A `#dr-badge` container is inserted into `.docs-titlebar-badges`. It contains one `.dr-link` element with an `img` child. The icon is visible in the titlebar next to the document name.
5. **Verify**: `document.querySelectorAll('#dr-badge').length === 1`, `document.querySelectorAll('.dr-link').length === 1`, image loaded (`img.complete === true`, `img.naturalWidth > 0`). Take a screenshot.

### Google Docs — idempotency (navigate away and back) [auto]

1. Navigate away from the doc and back (or reload the page).
2. **Expect**: Still exactly 1 `#dr-badge` and 1 `.dr-link`. The `getElementById('dr-badge')` guard prevents duplicates.

### Google Docs — click the icon [manual]

1. Click the injected icon.
2. **Expect**: A new tab opens at `http://localhost:3000/open?doc=...` which redirects to:
   - `/comments/{docId}` if the doc is already tracked in Docreview.
   - `/add?doc=...` if the doc is not yet tracked.

### Google Drive — list view [auto]

1. Navigate to Google Drive (Home or My Drive, list view).
2. Wait for the content script to inject.
3. **Expect**: A `.dr-link` icon appears next to each file's type icon in every `[role="row"]` that has a `[data-id]` with length > 20. The icon count should match the number of qualifying file rows.
4. **Verify**: Count `.dr-link` elements matches qualifying rows. Images loaded. Take a screenshot.

### Google Drive — idempotency [auto]

1. Navigate away and back without a full reload.
2. **Expect**: Same number of `.dr-link` elements — no duplicates. The `.querySelector('.dr-link')` guard on each row prevents re-injection.

### Google Drive — grid view [manual]

1. Switch Drive to grid/boxes view (click the Grid radio button).
2. Wait for the content script to inject.
3. **Expect**: Icons injected into `[role="gridcell"]` elements that have qualifying `[data-id]` attributes.

### Google Drive — MutationObserver persistence [manual]

1. Wait for the content script to inject in list view.
2. Navigate within Drive (e.g., click into a folder, then back).
3. **Expect**: Icons re-appear on newly rendered rows without reloading the page, because the MutationObserver calls `injectDrive()` on DOM changes.

### Google Sheets — titlebar badge [auto]

1. Open a Google Sheets document.
2. **Expect**: The `injectDocs()` path runs (hostname is `docs.google.com`). Sheets has `.docs-titlebar-badges`, so a `#dr-badge` with one `.dr-link` is injected into the titlebar, same as Google Docs.

### Google Slides — titlebar badge [auto]

1. Open a Google Slides presentation.
2. **Expect**: Same as Sheets — Slides also has `.docs-titlebar-badges`, so the badge is injected successfully. The `injectDocs()` code path works across all three Workspace editors.

### Gmail — inbox list chips [auto]

1. Open Gmail at `https://mail.google.com` with notification emails visible (sharing invitations, comment notifications).
2. Wait for the content script to inject.
3. **Expect**: A `.dr-link` icon appears inside each `[data-docurl]` chip, before the document type `img`. The chip gets `display: inline-flex` and `align-items: center`.
4. **Verify**: Count `.dr-link` elements matches `[data-docurl]` chip count. Images loaded. Take a screenshot.

### Gmail — inbox list idempotency [auto]

1. Navigate away and back without a full reload.
2. **Expect**: Same number of `.dr-link` elements — no duplicates. The `.querySelector('.dr-link')` guard on each chip prevents re-injection.

### Gmail — inbox list click [manual]

1. Click an injected `.dr-link` icon in an inbox chip.
2. **Expect**: A new tab opens at `http://localhost:3000/open?doc={encoded-docurl}`.

### Gmail — message view bar (SPA navigation) [auto]

1. With the content script already active (MutationObserver running), click a notification email in the inbox to open it.
2. **Expect**: An "Open in Docreview" bar (`.dr-gmail-bar`) appears above the email body iframe inside `[data-message-id]`. The bar contains "Open in " text followed by a link with the Docreview icon and "Docreview" text. The bar is centered in the first 80% of the row (`padding-right: 20%`).
3. **Verify**: `document.querySelector('.dr-gmail-bar')` exists. The link `href` contains `http://localhost:3000/open?doc=`. Take a screenshot.

### Gmail — message view bar idempotency [auto]

1. Navigate back to inbox, then click the same email again.
2. **Expect**: Still only one `.dr-gmail-bar`. The `!iframe.parentElement.querySelector('.dr-gmail-bar')` guard prevents duplicates.

### Gmail — message view bar (direct page load) [manual]

1. Reload the browser while viewing a notification email (direct page load, not SPA navigation).
2. Wait for the content script to inject.
3. **Expect**: The `.dr-gmail-bar` does **not** appear, because `[data-docurl]` chips are part of the inbox list DOM and are not rendered on direct page loads. No error is thrown.

### Gmail — MutationObserver persistence [manual]

1. With the content script active on the inbox.
2. Navigate within Gmail (e.g., open an email, go back to inbox, switch labels).
3. **Expect**: Icons re-appear on newly rendered chips without reloading the page, because the MutationObserver calls `injectGmail()` on DOM changes.

### Non-Google page [manual]

1. Navigate to a non-Google page (e.g., `http://localhost:3000/docs`).
2. **Expect**: The content script only runs on matched host patterns (Google domains), so nothing is injected. No errors.

## Toolbar button

Source: `src/chrome-extension/background.js`

### Google Docs (supported) [manual]

1. Open a Google Doc.
2. Click the Docreview extension toolbar button.
3. **Expect**: A new tab opens at `http://localhost:3000/open?doc={encoded-url}`. The `/open` route redirects to `/comments/{id}` (existing doc) or `/add?doc=...` (new doc).

### Google Sheets (supported) [manual]

1. Open a Google Sheets document.
2. Click the toolbar button.
3. **Expect**: A new tab opens at `http://localhost:3000/open?doc={encoded-url}` — the regex matches the `spreadsheets` path.

### Google Slides (supported) [manual]

1. Open a Google Slides presentation.
2. Click the toolbar button.
3. **Expect**: A new tab opens at `http://localhost:3000/open?doc={encoded-url}` — the regex matches the `presentation` path.

### Google Drive (unsupported) [manual]

1. Navigate to `https://drive.google.com`.
2. Click the toolbar button.
3. **Expect**: No new tab opens (Drive URLs are not individual documents).

### Docreview page (unsupported) [manual]

1. Navigate to `http://localhost:3000/docs`.
2. Click the toolbar button.
3. **Expect**: No action (not a supported document URL).

### Gmail — with doc chip (supported) [manual]

1. Open a notification email in Gmail (via SPA navigation from inbox, so `[data-docurl]` chips exist).
2. Click the toolbar button.
3. **Expect**: A new tab opens at `http://localhost:3000/open?doc={encoded-docurl}`, using the URL from the first `[data-docurl]` chip found via `executeScript(allFrames)`.

### Gmail — without doc chip [manual]

1. Open a non-notification email in Gmail (one without `[data-docurl]` chips), or reload a notification email directly (chips won't be in DOM).
2. Click the toolbar button.
3. **Expect**: No new tab opens (no document URL found).

## Comment activity sync [manual]

Source: `src/chrome-extension/content.js` (detection), `src/chrome-extension/background.js` (extraction + sync), `src/lib/sync-comments.ts` (`syncSingleComment`)

For each test case, check the browser console (Google Docs tab) for `[docreview]` logs and the extension service worker console for `[background]` logs. Verify:
- The disco ID is extracted (look for `extracted comment ID: AAAB...`)
- The correct `commentType` is sent (`comment` or `suggestion`)
- For comments with an extracted ID, the server log shows `single-comment sync AAAB...`
- For suggestions, the server log shows `(suggestion)` and syncs from Docs API only

### New comment — Post Comment button [manual]

1. Open a Google Doc with existing comments. Select some text and click the comment icon (or Ctrl+Alt+M).
2. Type a comment and click "Post Comment".
3. **Expect**: Content script detects the action on `mouseup`. No listitem exists at `mousedown` time (new comment), so the mutation observer watches for the added listitem. After the new comment appears in the DOM, `commentPre` is sent. Background extracts the disco ID (may retry while Closure attaches internals). Server does single-comment sync.
4. **Verify**: `[background] extracted comment ID: AAAB...` appears in service worker logs. Server log shows `single-comment sync`.

### Reply to comment — button [manual]

1. Open a comment thread and type a reply.
2. Click the "Reply to comment" button.
3. **Expect**: `mousedown` marks the listitem and sends `commentPre`. `mouseup` detects the reply action with `commentType='comment'`. Background extracts the disco ID and fires single-comment sync.
4. **Verify**: `[docreview] comment activity detected: reply (extracting ID)` in Docs console. `[background] extracted comment ID: AAAB...` in service worker.

### Reply to comment — Ctrl+Enter [manual]

1. Open a comment thread and type a reply.
2. Press Ctrl+Enter (or Cmd+Enter on Mac) to submit.
3. **Expect**: `keydown` handler marks the listitem and sends `commentPre`. Mutation observer confirms the DOM change. Background extracts ID and fires single-comment sync.
4. **Verify**: Same logs as button reply — `(extracting ID)` and `extracted comment ID`.

### Reply to suggestion — button [manual]

1. Open a suggestion thread (one with Accept/Reject buttons) and type a reply.
2. Click the "Reply to comment" button.
3. **Expect**: `mousedown` marks the listitem. `mouseup` detects `commentType='suggestion'` (Accept/Reject buttons present in listitem). Server syncs from Docs API only (skips Drive comments). Disco ID is extracted for logging but not used for single-comment sync.
4. **Verify**: `[docreview] comment activity detected: reply suggestion (extracting ID)` in Docs console. Server log shows `(suggestion)`.

### Reply to suggestion — Ctrl+Enter [manual]

1. Open a suggestion thread and type a reply.
2. Press Ctrl+Enter to submit.
3. **Expect**: Same as button reply to suggestion — `commentType='suggestion'`, Docs API sync.

### Accept suggestion [manual]

1. Click the "Accept suggestion" button on a suggestion.
2. **Expect**: `mousedown` marks the listitem and extracts the disco ID. `mouseup` detects `commentType='suggestion'`. Server syncs from Docs API only. The accepted suggestion should be marked resolved in the DB.
3. **Verify**: `[docreview] comment activity detected: accept suggestion (extracting ID)`. Server log shows `(suggestion)`.

### Reject suggestion [manual]

1. Click the "Reject suggestion" button on a suggestion.
2. **Expect**: Same as Accept — `commentType='suggestion'`, Docs API sync, suggestion marked resolved.

### Resolve comment [manual]

1. Click "Mark as resolved and hide discussion" on a comment thread.
2. **Expect**: `mousedown` marks the listitem and extracts the disco ID before Google removes the element on `mouseup`. `commentType='comment'`. Server does single-comment sync — the comment should be marked resolved in the DB.
3. **Verify**: `[docreview] comment activity detected: resolve (extracting ID)`. `[background] extracted comment ID: AAAB...`. Server log shows `single-comment sync`.

### Rapid actions on different comments [manual]

1. Quickly reply to comment A, then reply to comment B within 1 second.
2. **Expect**: Both get independent single-comment syncs (per-comment debounce keys). Neither blocks the other.
3. **Verify**: Two separate `(firing immediately)` log lines with different comment IDs.

## Comment navigation — diff/version history view [manual]

Source: `src/chrome-extension/background.js` (`navigateToComment`, `isDiffViewFunc`)

### Navigate to comment while diff view is open [manual]

1. Open a Google Doc that has comments tracked in Docreview.
2. In the Doc, open the version history (File > Version history > See version history) or the "Changes since" diff view.
3. In Docreview, click "Open" on a comment for that doc.
4. **Expect**: A new tab opens adjacent to the diff-view tab with the doc at the comment location. The diff-view tab is not disturbed.

### Close new tab, navigate again [manual]

1. Continue from the previous test (diff-view tab + new comment tab open).
2. Close the new comment tab.
3. In Docreview, click "Open" on another comment for that doc.
4. **Expect**: The extension rediscovers the diff-view tab via URL search, detects it's still in diff view, and opens a new adjacent tab again.

### Diff view closed, normal navigation resumes [manual]

1. Open a Google Doc that has comments tracked in Docreview.
2. Open the version history, then close it (click the back arrow to return to normal editing).
3. In Docreview, click "Open" on a comment.
4. **Expect**: The extension navigates to the comment in the existing tab (normal in-page navigation, no new tab).
