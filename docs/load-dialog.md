# Load Dialog

The Load dialog discovers documents from Google Drive and adds them to the user's
tracked list. It uses a two-phase **scan → add** flow so the user can review what
will be added before committing.

## UI Flow

```
[Load…] button
    │
    ▼
┌──────────────────────────────┐
│  Load from Drive             │
│                              │
│  Time window: [30] days back │
│  Which documents: [All ▾]    │
│  ☐ Include shared drives     │
│                              │
│            [Scan]   [Cancel] │
└──────────────────────────────┘
    │
    ▼  (scan completes)
┌──────────────────────────────┐
│  Load from Drive             │
│                              │
│  Time window / Which / Shared│
│  ─────────────────────────── │
│  Total documents found: 42   │
│  New documents: 5            │
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
(read-only — no DB writes). The response shows total docs found and a list of new
(not-yet-tracked) documents. All new docs are selected by default.

### Phase 2 — Review & Add

The user can remove docs from the list by clicking the ✕ button. Removed docs will
not be added. Doc titles are clickable links that open in Google Drive.

If any docs were removed, a "N documents selected" line appears below the list.

The user can optionally assign labels and notes that will be applied to all newly
added documents.

Clicking **Add** calls `POST /api/docs?mode=load` with the selected doc IDs, options,
labels, and notes. The backend re-queries Drive with the same options (rather than
trusting client-passed metadata), filters to the selected IDs, and upserts each doc.
After the sync completes, the doc list refreshes and a toast summarizes results.

Clicking **Rescan** re-runs the scan with current options (useful after changing the
time window or ownership filter).

**Cancel** aborts any in-progress scan or add operation and closes the dialog.

---

## Search Options

| Option | Default | Values | Effect |
|--------|---------|--------|--------|
| Time window | 30 days | 1–365 | `files.list` query filters by `modifiedTime > cutoff` |
| Which documents | All accessible | All / Only owned / Only shared with me | Adds `'me' in owners` or `sharedWithMe` to Drive query |
| Include shared drives | Off | Checkbox | Sets `corpora: "allDrives"` and `includeItemsFromAllDrives: true` |

Options are validated by `parseLoadOptions()` in `src/lib/load-options.ts`, shared
between the scan and load endpoints.

---

## API Endpoints

### `POST /api/docs/scan`

Read-only scan. Queries Drive with the specified options, compares against the DB,
and returns results without modifying anything.

**Request body:**
```json
{
  "daysBack": 30,
  "ownership": "all",
  "includeSharedDrives": false
}
```

**Response:**
```json
{
  "total": 42,
  "existingCount": 37,
  "newDocs": [
    {
      "googleDocId": "abc123",
      "title": "Design Doc",
      "mimeType": "application/vnd.google-apps.document",
      "driveUrl": "https://docs.google.com/document/d/abc123/edit",
      "owner": "alice@example.com",
      "role": "REVIEWER"
    }
  ]
}
```

### `POST /api/docs?mode=load`

Adds documents and syncs comments. For full backend details (upsert logic, deletion
detection, comment sync, token lifecycle), see [`refresh.md`](./refresh.md).

**Request body (load mode):**
```json
{
  "daysBack": 30,
  "ownership": "all",
  "includeSharedDrives": false,
  "selectedGoogleDocIds": ["abc123", "def456"],
  "labelIds": ["label-1"],
  "notes": "Q3 review batch"
}
```

**Additional load-mode behavior:**
- `selectedGoogleDocIds` — only new docs in this set are added; existing docs still
  get metadata updates regardless of selection.
- `labelIds` — validated for ownership before processing; applied to newly created
  docs only (not existing ones).
- `notes` — applied to newly created docs only.

---

## Dialog Layout

The dialog uses a flex column layout with controlled shrinking:

- **Top section** (options + summary) — `shrink-0`, always fully visible
- **Doc list** — `shrink`, compresses first when the dialog is too tall for the viewport;
  min height of 5 rows, max height of 15 rows, internal scroll
- **Bottom section** (labels + notes) — `shrink-0`, always fully visible
- **Footer** (buttons) — fixed at bottom

When the dialog cannot fit even with the doc list at minimum size, an overall
scrollbar appears on the dialog content area.

---

## Re-query Design

The Add step re-queries Drive with the same search options rather than passing the
scanned doc metadata back from the client. This is consistent with the rest of the
codebase's trust model: the server always fetches its own data from Drive and the
client only sends IDs and user choices (selections, labels, notes). The cost is one
extra Drive API call; the benefit is that the server never writes stale or
client-tampered metadata to the database.
