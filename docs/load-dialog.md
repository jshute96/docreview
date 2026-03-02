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

Searches Gmail for notification emails from:
- `drive-shares-dm-noreply@google.com` (sharing notifications)
- `comments-noreply@docs.google.com` (comment notifications)

For each email, the scanner extracts the Google Doc link from the body, then
fetches the real doc title and metadata from Drive. Emails where no doc link
can be extracted, or where Drive metadata fails to fetch, are counted as errors
and logged (but not shown in the doc list). The error count is displayed in the
scan summary.

When Gmail is selected, the ownership filter and shared drives checkbox are
hidden (not applicable).

Switching sources clears any existing scan results.

## UI Flow

```
[Load…] button
    │
    ▼
┌──────────────────────────────┐
│  Load from Drive             │
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
│  Load from Drive             │
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
│  Labels: [picker]            │
│  Notes:  [textarea]          │
│                              │
│      [Add] [Rescan] [Cancel] │
└──────────────────────────────┘
```

### Phase 1 — Scan

The user configures search options and clicks **Scan**. This calls `POST /api/docs/scan`
(read-only — no DB writes). The response returns all matching docs, each flagged with
`isNew` to indicate whether it's already tracked. The default view shows only new docs.

### Phase 2 — Review & Add

A **New / All** toggle above the doc list controls which docs are visible:
- **New** (default) — shows only not-yet-tracked documents
- **All** — shows all scanned documents, including already-tracked ones

New documents display a green **NEW** badge between the ✕ button and the doc icon.

The user can remove docs from the list by clicking the ✕ button. Removed docs persist
across view switches (removing a doc in "All" view keeps it removed in "New" view).
Doc titles are clickable links that open in Google Drive.

If any docs were removed, a "N documents selected" line appears below the list.

The user can optionally assign labels and notes:
- **New docs:** labels and notes are set on creation
- **Existing docs:** labels are added (duplicates skipped), notes are appended with a
  newline separator

Clicking **Add** calls `POST /api/docs?mode=load` with the visible (non-removed) doc
IDs, options, source, labels, and notes. For Drive loads, the backend re-queries via
`files.list` with the same options; for Gmail loads, it fetches metadata directly by
doc ID via `files.get`. After the sync completes, the doc list refreshes and a toast
summarizes results.

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

**Request body (Drive load):**
```json
{
  "source": "drive",
  "daysBack": 30,
  "ownership": "all",
  "includeSharedDrives": false,
  "selectedGoogleDocIds": ["abc123", "def456"],
  "labelIds": ["label-1"],
  "notes": "Q3 review batch"
}
```

**Request body (Gmail load):**
```json
{
  "source": "gmail",
  "daysBack": 30,
  "selectedGoogleDocIds": ["abc123", "def456"],
  "labelIds": ["label-1"],
  "notes": "Q3 review batch"
}
```

**Additional load-mode behavior:**
- `source` — `"drive"` (default) re-queries via `files.list` with search options;
  `"gmail"` fetches metadata directly by doc ID via `files.get` (since the docs
  were discovered via email, not a Drive listing). Gmail loads also skip the
  missing-docs deletion check (irrelevant when loading specific IDs).
- `selectedGoogleDocIds` — docs not in this set are skipped entirely (no upsert,
  no labels, no notes). For Gmail loads, this is the authoritative list of docs
  to fetch.
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

## Gmail Scanning Details

The Gmail scanner (`src/lib/gmail.ts`) works as follows:

1. Queries Gmail for messages from the two notification sender addresses, filtered by date
2. Fetches each message to extract headers (Subject, From, Date) and body
3. Parses the plaintext body with regex to find a `/d/DOC_ID/` pattern
4. For messages with a doc ID, calls Drive `files.get` to fetch real title, mimeType, webViewLink, and owner
5. Messages with no doc link or failed Drive fetch are logged as errors and counted
6. Deduplicates by googleDocId (multiple emails may reference the same doc)
7. Returns `{ docs, errorCount }` — only successfully resolved docs are included

The Gmail scope (`gmail.readonly`) is requested alongside Drive scopes in `src/auth.ts`.
Users must sign out and sign back in to grant the new scope.

---

## Re-query Design

The Add step re-queries Drive rather than passing the scanned doc metadata back
from the client. For Drive loads, this uses `files.list` with the same search
options; for Gmail loads, it fetches each doc by ID via `files.get`. This is
consistent with the rest of the codebase's trust model: the server always fetches
its own data from Drive and the client only sends IDs and user choices (selections,
labels, notes). The cost is extra Drive API calls; the benefit is that the server
never writes stale or client-tampered metadata to the database.
