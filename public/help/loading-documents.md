There are several ways to add documents to Docreview.

## Refresh

The **Refresh** button in the toolbar is the primary way to keep Docreview up to date. It runs two scans in parallel:

- **Drive scan** -- Checks Google Drive's change feed for documents you own or have accessed that were recently modified. On first use, it bootstraps by scanning the last 7 days.
- **Gmail scan** -- Reads notification emails from Google to detect documents shared with you or where you were @mentioned in comments.

After scanning, Docreview fetches metadata for any new documents found and syncs comments for all tracked documents.

A toast notification shows real-time progress and a summary when complete: how many documents were added, updated, or removed.

If your Google account doesn't have Gmail enabled (some Google accounts that were never set up with Gmail, or Google Workspace users whose admin has disabled the Gmail service), the Gmail scan is skipped and a "No Gmail account" warning is shown. The Drive scan still runs as usual. Email notifications won't be visible to Docreview.

### Menu refresh options

The hamburger menu provides more targeted refresh options:

- **Refresh from Drive** -- Drive scan only (no Gmail).
- **Refresh from Gmail** -- Gmail scan only (no Drive).
- **Refresh selected** -- Refresh metadata and comments only for the documents currently shown in your filtered list.
- **Full refresh** -- Exhaustive metadata fetch for every document in your database. Use this occasionally to catch up on changes that incremental refresh might miss.

## Load dialog

For more control over which documents to import, use the **Load** button to open the Load dialog. This is a two-phase process:

### Phase 1: Scan

Choose your scan options:
- **Source** -- Drive or Gmail.
- **Time window** -- How far back to look (1 to 365 days, or all).
- **Ownership** (Drive only) -- All documents, only ones you own, or only ones shared with you.
- **Shared drives** (Drive only) -- Whether to include documents from shared drives.

Click **Scan** to search. This is read-only -- nothing is added to your database yet.

### Phase 2: Review and add

After scanning, you see a list of found documents. Two view modes are available:

- **New** -- Only documents not already in Docreview. This is the default.
- **All** -- All found documents, with "NEW" badges on untracked ones. Selecting an existing document in this view will update its labels and notes.

You can remove documents from the selection by clicking the X button on each row. Before adding, you can optionally:

- **Apply labels** -- Select labels to apply to all imported documents.
- **Set notes** -- Enter notes to attach to all imported documents.
- **Add to Inbox** -- Checked by default. Uncheck to add documents as Archived.

Click **Add** to import the selected documents.

## Add doc page

The **Add doc page** (available from the menu) lets you add a single document by URL. Paste a Google Docs, Sheets, or Slides URL and Docreview will validate it, show the document title and owner, and let you set role, labels, notes, and star before adding.

If the document is already tracked, the page shows a link to its comment detail page and offers to update it instead.

## Chrome extension

The Chrome extension adds Docreview icons to Google Docs, Drive, and Gmail, letting you add documents with one click while browsing. See the Chrome Extension help page for details.
