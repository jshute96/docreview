# Load Dialog

The Load dialog discovers documents from Google Drive or Gmail and adds them to
the user's tracked list. It uses a two-phase **scan → add** flow so the user can
review what will be added before committing.

## Sources

A **Drive / Gmail** toggle at the top of the options section controls where the
scan looks for documents.

### Drive (default)

Queries `files.list` with time window, ownership, and shared drives filters.
Returns Google Docs/Sheets/Slides modified within the time window.

### Gmail

Searches Gmail for doc notification emails, extracts doc IDs, and fetches Drive
metadata. See [`gmail.md`](./gmail.md) for full scanner details.

When Gmail is selected, the ownership filter and shared drives checkbox are
hidden (not applicable). Switching sources clears any existing scan results.

## UI Flow

```
[Load…] button
    │
    ▼
┌──────────────────────────────┐
│  Load from Drive or Gmail    │
│                              │
│  Source: [Drive] [Gmail]     │
│  Time window: [30] days back │
│  Which documents: [All ▾]    │  ← Drive only
│  ☐ Include shared drives     │  ← Drive only
│                              │
│            [Scan]   [Cancel] │
└──────────────────────────────┘
    │
    ▼  (scan completes)
┌──────────────────────────────┐
│  Load from Drive or Gmail    │
│                              │
│  Source / Time / Which / ...  │
│  ─────────────────────────── │
│  Total documents found: 42   │
│  New documents: 5            │
│  3 emails could not be ...   │  ← Gmail only, if > 0
│  [New] [All]                 │
│  ┌──────────────────────┐    │
│  │ ✕ 📄 Design Doc      │    │
│  │ ✕ 📊 Q3 Budget       │    │
│  │ ✕ 📄 API Spec        │    │
│  │ ...                   │    │
│  └──────────────────────┘    │
│  Labels: [★ picker]           │
│  Notes:  [textarea]          │
│                              │
│      [Add] [Rescan] [Cancel] │
└──────────────────────────────┘
```

### Phase 1 — Scan

The user configures search options and clicks **Scan**. This calls `POST /api/docs/scan`
(read-only — no DB writes). 

This endpoint uses **Server-Sent Events (SSE)** to report real-time scanning progress
in a toast message:
- **Drive Scan:** Reports raw objects scanned from the API (e.g., "Reading changes from Drive (1650 found)...").
- **Gmail Scan:** Reports messages scanned out of the total found, followed by a metadata
  fetching phase for discovered IDs (e.g., "Reading notifications from Gmail (12 of 50)...").

Once the scan completes, the results are displayed in the dialog list, flagged with
`isNew` to indicate whether they are already tracked. The default view shows only new docs.

### Phase 2 — Review & Add

A **New / All** toggle above the doc list controls which docs are visible:
- **New** (default) — shows only not-yet-tracked documents
- **All** — shows all scanned documents, including already-tracked ones

New documents display a green **NEW** badge between the ✕ button and the doc icon.

The user can remove docs from the list by clicking the ✕ button. Removed docs persist
across view switches (removing a doc in "All" view keeps it removed in "New" view).
Doc titles are clickable links that open in Google Drive.

If any docs were removed, a "N documents selected" line appears below the list.

The user can optionally assign star, labels, notes, and document status:
- **New docs:** labels and notes are set on creation. If **Add to Inbox** is checked (default),
  status is set to `INBOX`; otherwise `ARCHIVED`.
- **Existing docs:** labels are added (duplicates skipped), notes are appended with a
  newline separator. If **Move to Inbox** is checked, status is updated to `INBOX`;
  otherwise it is set to `ARCHIVED`.

Clicking **Add** calls `POST /api/docs?mode=load` with the visible (non-removed) doc
IDs, source, labels, and notes. The backend fetches metadata for the selected docs by
ID via `files.get` (both Drive and Gmail sources). After the sync completes, the doc
list refreshes and a toast summarizes results.

Clicking **Rescan** re-runs the scan with current options (useful after changing the
time window or ownership filter).

**Cancel** aborts any in-progress scan or add operation and closes the dialog.

---

## Search Options

| Option | Default | Values | Effect |
|--------|---------|--------|--------|
| Source | Drive | Drive / Gmail | Drive queries `files.list`; Gmail searches notification emails |
| Time window | 30 days | 1–365 | Drive: `modifiedTime > cutoff`; Gmail: `after:YYYY/MM/DD` query |
| Which documents | All accessible | All / Only owned / Only shared with me | Adds `'me' in owners` or `sharedWithMe` to Drive query (Drive only) |
| Include shared drives | Off | Checkbox | Sets `corpora: "allDrives"` and `includeItemsFromAllDrives: true` (Drive only) |

Options are validated by `parseLoadOptions()` in `src/lib/load-options.ts`, shared
between the scan and load endpoints.

---

## API Endpoints

### `POST /api/docs/scan`

Read-only scan. Queries Drive or Gmail with the specified options, compares against
the DB, and returns results without modifying anything.

This is an **SSE (Server-Sent Events)** endpoint that streams progress events before
sending the final result.

**Request body (Drive):**
```json
{
  "source": "drive",
  "daysBack": 30,
  "ownership": "all",
  "includeSharedDrives": false
}
```

**Request body (Gmail):**
```json
{
  "source": "gmail",
  "daysBack": 30
}
```

**Response:**
```json
{
  "total": 42,
  "existingCount": 37,
  "errorCount": 3,
  "docs": [
    {
      "googleDocId": "abc123",
      "title": "Design Doc",
      "mimeType": "application/vnd.google-apps.document",
      "driveUrl": "https://docs.google.com/document/d/abc123/edit",
      "owner": "alice@example.com",
      "role": "REVIEWER",
      "isNew": true
    }
  ]
}
```

`errorCount` is only present for Gmail scans and counts emails where no doc link
could be extracted or Drive metadata could not be fetched.

### `POST /api/docs?mode=load`

Adds documents and syncs comments. For full backend details (upsert logic, deletion
detection, comment sync, token lifecycle), see [`refresh.md`](./refresh.md).

**Request body:**
```json
{
  "source": "drive",
  "selectedGoogleDocIds": ["abc123", "def456"],
  "labelIds": ["label-1"],
  "notes": "Q3 review batch",
  "status": "INBOX"
}
```

**Additional load-mode behavior:**
- Both Drive and Gmail loads fetch metadata by doc ID via `files.get` — only the
  selected docs are fetched, regardless of source. Deletion detection is not
  performed during loads (that's handled by refresh/full-refresh via `changes.list`).
- `selectedGoogleDocIds` — the authoritative list of docs to fetch metadata for.
  Docs not in this set are never fetched or processed.
- `labelIds` — validated for ownership before processing. New docs: set on creation.
  Existing selected docs: added via `createMany` with `skipDuplicates`.
- `notes` — New docs: set on creation. Existing selected docs: appended with a
  newline separator (matching the bulk-update pattern).

---

## Dialog Layout

The dialog follows the shared dialog sizing pattern (see [`dialog-sizing.md`](./dialog-sizing.md)):

- **Top section** (source toggle + options + summary + error count + view toggle) — `shrink-0`, always fully visible
- **Doc list** — `shrink`, flexible item list (5–15 rows)
- **Bottom section** (selected count + labels + notes) — `shrink-0`, always fully visible
- **Footer** (buttons) — fixed at bottom

The `docListRows` state tracks the preferred list height. It recomputes on view
switch (New ↔ All, accounting for removals) and on rescan (fresh data), but NOT
on individual X-click removals. This is important so that the dialog box doesn't
move when clicking X, because that's annoying when trying to click X on multiple rows.

---

## Gmail

For Gmail scanner internals, the **Refresh from Gmail** toolbar button, and a
comparison of Load vs Refresh flows, see [`gmail.md`](./gmail.md).

---

## Re-fetch Design

The Add step fetches fresh metadata from Drive by doc ID (`files.get`) rather than
passing the scanned doc metadata back from the client. This is consistent with the
rest of the codebase's trust model: the server always fetches its own data from
Drive and the client only sends IDs and user choices (selections, labels, notes).
The cost is one `files.get` call per selected doc; the benefit is that the server
never writes stale or client-tampered metadata to the database.
