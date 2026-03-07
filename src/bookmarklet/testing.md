# Bookmarklet Test Cases

Test these using the `/test-ui` skill with a logged-in browser session. See the "Bookmarklet Testing" section in the skill for how to execute bookmarklets via Playwright.

Tests reference CSS selectors like `#dr-badge` and `.dr-link` — these are IDs and classes defined in the bookmarklet source code. Read the source files to understand what they are and how the idempotency guards work.

Read `README.md` for expected user-facing behavior of the bookmarklets.

When referencing a test, use the format `src/bookmarklet/testing.md:LINE` "Test Name" (e.g., `src/bookmarklet/testing.md:29` "Google Docs — fresh page").

## Setup

1. Log in as the first test user via the skill's Login flow.
2. Open the Docreview docs page at `http://localhost:3000/docs`.
3. From the docs list, click "Open" on a Google Doc to open it in Google Docs. (Look at the file type icon to find a Doc vs. Sheets vs. Slides if a specific type is needed.)
4. Open Google Drive at `https://drive.google.com` in another tab.

## "Add Docreview links" bookmarklet

Source: `bookmarklet-source.js`

### Google Docs — fresh page

1. Reload the Google Docs page.
2. Verify clean state: no `#dr-badge`, no `.dr-link` elements.
3. Run the bookmarklet.
4. **Expect**: A `#dr-badge` container is inserted into `.docs-titlebar-badges`. It contains one `.dr-link` element with an `img` child. The icon is visible in the titlebar next to the document name.
5. **Verify**: `document.querySelectorAll('#dr-badge').length === 1`, `document.querySelectorAll('.dr-link').length === 1`, image loaded (`img.complete === true`, `img.naturalWidth > 0`). Take a screenshot.

### Google Docs — idempotency (run twice)

1. Without reloading, run the bookmarklet a second time.
2. **Expect**: Still exactly 1 `#dr-badge` and 1 `.dr-link`. The `getElementById('dr-badge')` guard prevents duplicates.

### Google Docs — click the icon

1. Click the injected icon.
2. **Expect**: A new tab opens at `http://localhost:3000/open?doc=...` which redirects to:
   - `/comments/{docId}` if the doc is already tracked in Docreview.
   - `/add?doc=...` if the doc is not yet tracked.
3. **Known issue**: Playwright's `.click()` triggers both the `click` and `mouseup` event handlers, causing two tabs to open. This doesn't happen with real user clicks. The duplicate `window.open` in the `mouseup` handler is arguably a bug in the bookmarklet.

### Google Drive — list view

1. Navigate to Google Drive (Home or My Drive, list view).
2. Run the bookmarklet.
3. **Expect**: A `.dr-link` icon appears next to each file's type icon in every `[role="row"]` that has a `[data-id]` with length > 20. The icon count should match the number of qualifying file rows.
4. **Verify**: Count `.dr-link` elements matches qualifying rows. Images loaded. Take a screenshot.

### Google Drive — idempotency

1. Run the bookmarklet again without reloading.
2. **Expect**: Same number of `.dr-link` elements — no duplicates. The `.querySelector('.dr-link')` guard on each row prevents re-injection.

### Google Drive — grid view

1. Switch Drive to grid/boxes view (click the Grid radio button).
2. Run the bookmarklet.
3. **Expect**: Icons injected into `[role="gridcell"]` elements that have qualifying `[data-id]` attributes.

### Google Drive — MutationObserver persistence

1. Run the bookmarklet in list view.
2. Navigate within Drive (e.g., click into a folder, then back).
3. **Expect**: Icons re-appear on newly rendered rows without re-running the bookmarklet, because the MutationObserver calls `injectDrive()` on DOM changes.

### Google Sheets — titlebar badge

1. Open a Google Sheets document.
2. Run the bookmarklet.
3. **Expect**: The `injectDocs()` path runs (hostname is `docs.google.com`). Sheets has `.docs-titlebar-badges`, so a `#dr-badge` with one `.dr-link` is injected into the titlebar, same as Google Docs.

### Google Slides — titlebar badge

1. Open a Google Slides presentation.
2. Run the bookmarklet.
3. **Expect**: Same as Sheets — Slides also has `.docs-titlebar-badges`, so the badge is injected successfully. The `injectDocs()` code path works across all three Workspace editors.

### Gmail — inbox list chips

1. Open Gmail at `https://mail.google.com` with notification emails visible (sharing invitations, comment notifications).
2. Run the bookmarklet.
3. **Expect**: A `.dr-link` icon appears inside each `[data-docurl]` chip, before the document type `img`. The chip gets `display: inline-flex` and `align-items: center`.
4. **Verify**: Count `.dr-link` elements matches `[data-docurl]` chip count. Images loaded. Take a screenshot.

### Gmail — inbox list idempotency

1. Run the bookmarklet again without reloading.
2. **Expect**: Same number of `.dr-link` elements — no duplicates. The `.querySelector('.dr-link')` guard on each chip prevents re-injection.

### Gmail — inbox list click

1. Click an injected `.dr-link` icon in an inbox chip.
2. **Expect**: A new tab opens at `http://localhost:3000/open?doc={encoded-docurl}`.

### Gmail — message view bar (SPA navigation)

1. With the bookmarklet already active (MutationObserver running), click a notification email in the inbox to open it.
2. **Expect**: An "Open in Docreview" bar (`.dr-gmail-bar`) appears above the email body iframe inside `[data-message-id]`. The bar contains "Open in " text followed by a link with the Docreview icon and "Docreview" text. The bar is centered in the first 80% of the row (`padding-right: 20%`).
3. **Verify**: `document.querySelector('.dr-gmail-bar')` exists. The link `href` contains `http://localhost:3000/open?doc=`. Take a screenshot.

### Gmail — message view bar idempotency

1. Navigate back to inbox, then click the same email again.
2. **Expect**: Still only one `.dr-gmail-bar`. The `!iframe.parentElement.querySelector('.dr-gmail-bar')` guard prevents duplicates.

### Gmail — message view bar (direct page load)

1. Reload the browser while viewing a notification email (direct page load, not SPA navigation).
2. Run the bookmarklet.
3. **Expect**: The `.dr-gmail-bar` does **not** appear, because `[data-docurl]` chips are part of the inbox list DOM and are not rendered on direct page loads. No error is thrown.

### Gmail — MutationObserver persistence

1. Run the bookmarklet on the inbox.
2. Navigate within Gmail (e.g., open an email, go back to inbox, switch labels).
3. **Expect**: Icons re-appear on newly rendered chips without re-running the bookmarklet, because the MutationObserver calls `injectGmail()` on DOM changes.

### Non-Google page

1. Navigate to a non-Google page (e.g., `http://localhost:3000/docs`).
2. Run the bookmarklet.
3. **Expect**: Nothing happens (the `if (!isDocs && !isDrive && !isGmail) return` guard exits silently). No errors, no injected elements.

## "Open in Docreview" bookmarklet

Source: `open-in-docreview-source.js`

### Google Docs (supported)

1. Open a Google Doc.
2. Run the bookmarklet.
3. **Expect**: A new tab opens at `http://localhost:3000/open?doc={encoded-url}`. The `/open` route redirects to `/comments/{id}` (existing doc) or `/add?doc=...` (new doc).

### Google Sheets (supported)

1. From the Docreview docs list, find a Sheets document (look for the Sheets icon) and click "Open".
2. Run the bookmarklet on the Sheets page.
3. **Expect**: A new tab opens at `http://localhost:3000/open?doc={encoded-url}` — the regex matches the `spreadsheets` path.

### Google Slides (supported)

1. From the Docreview docs list, find a Slides document (look for the Slides icon) and click "Open".
2. Run the bookmarklet on the Slides page.
3. **Expect**: A new tab opens at `http://localhost:3000/open?doc={encoded-url}` — the regex matches the `presentation` path.

### Google Drive (unsupported)

1. Navigate to `https://drive.google.com`.
2. Run the bookmarklet.
3. **Expect**: An alert dialog appears with the message "Not a supported document". Use `page.once('dialog')` pattern to capture and dismiss (see skill doc).

### Docreview page (unsupported)

1. Navigate to `http://localhost:3000/docs`.
2. Run the bookmarklet.
3. **Expect**: Same alert: "Not a supported document".

### Gmail — with doc chip (supported)

1. Open a notification email in Gmail (via SPA navigation from inbox, so `[data-docurl]` chips exist).
2. Run the bookmarklet.
3. **Expect**: A new tab opens at `http://localhost:3000/open?doc={encoded-docurl}`, using the URL from the first `[data-docurl]` chip.

### Gmail — without doc chip

1. Open a non-notification email in Gmail (one without `[data-docurl]` chips), or reload a notification email directly (chips won't be in DOM).
2. Run the bookmarklet.
3. **Expect**: An alert dialog appears with the message "No document link found in this email". Use `page.once('dialog')` pattern to capture and dismiss.

### Google Docs homepage (unsupported)

1. Navigate to `https://docs.google.com` (the Docs homepage, not an actual document).
2. Run the bookmarklet.
3. **Expect**: Alert "Not a supported document" — the URL doesn't match the `/d/{id}` pattern.
