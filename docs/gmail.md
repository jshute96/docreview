# Gmail Integration

Gmail is used to discover Google Docs that the user has interacted with via
notification emails. There are two ways Gmail scanning is triggered:

1. **Load dialog** — user-initiated, selective: scan Gmail, review results, choose
   which docs to add (see [`load-dialog.md`](./load-dialog.md))
2. **Refresh from Gmail button** — one-click incremental sync: scan Gmail since
   last timestamp, upsert all discovered docs automatically

Both paths use the same scanner (`src/lib/gmail.ts`).

---

## Scanner — `scanGmailNotifications(userId, since)`

The scanner accepts a `Date` and returns `{ docs: GmailScanDoc[], errorCount }`.

### Steps

1. Queries Gmail for messages from the two notification sender addresses, filtered
   by `after:YYYY/MM/DD` (day-level precision from the `since` Date):
   - `drive-shares-dm-noreply@google.com` (sharing notifications)
   - `comments-noreply@docs.google.com` (comment notifications)
2. Fetches each message (`format: "full"`) to extract headers and body
3. Filters by `internalDate >= since` for timestamp-level precision — the Gmail
   `after:` operator only has day-level granularity, so repeated calls within the
   same day would reprocess messages without this check
4. Parses the plaintext body with regex to find a `/d/DOC_ID/` pattern
5. For messages with a doc ID, calls Drive `files.get` to fetch real title,
   mimeType, webViewLink, and owner
6. Messages with no doc link or failed Drive fetch are logged as errors and counted
7. Deduplicates by googleDocId (multiple emails may reference the same doc)
8. Returns `{ docs, errorCount }` — only successfully resolved docs are included

### OAuth Scope

The `gmail.readonly` scope is requested alongside Drive scopes in `src/auth.ts`.
Users must sign out and sign back in to grant the new scope.

---

## Load Dialog — Gmail Source

When the user selects Gmail as the source in the Load dialog, the scan calls
`POST /api/docs/scan` with `source: "gmail"`. The scanner's `since` is computed
from the user-specified `daysBack` value.

The scan is read-only — no DB writes. Results are returned to the dialog for
review. The user selects which docs to add, optionally assigns labels and notes,
then clicks Add. The Add step fetches Drive metadata by doc ID (`files.get`) and
upserts — see [`load-dialog.md`](./load-dialog.md) for the full UI flow.

When Gmail is selected in the Load dialog:
- Ownership filter and shared drives checkbox are hidden (not applicable)
- Switching sources clears any existing scan results
- Error count is displayed in the scan summary (e.g., "3 emails could not be resolved")

---

## Refresh from Gmail Button

The **Refresh from Gmail** button in the toolbar (`RefreshButton` with
`mode="gmail-refresh"`) performs an incremental Gmail sync without user interaction.

### Flow — `POST /api/docs/gmail-refresh`

1. Read `lastGmailUpdateTimestamp` from the Status table
2. If no saved timestamp, default to 7 days ago
3. Scan Gmail since that timestamp
4. Extract unique doc IDs from scan results
5. Fetch full Drive metadata via `fetchDocsByIds`
6. Upsert each doc in the DB (create with all Drive fields + role; update metadata
   and clear `isDeleted`)
7. Detect deletions: doc IDs from Gmail not returned by `fetchDocsByIds` are
   checked via `findDeletedDocIds` (reuses existing 404/403 logic)
8. Sync comments for upserted docs via `syncComments`
9. Unarchive: if a doc is ARCHIVED and `syncResult.shouldUnarchive` is true, set
   it back to INBOX (MUTED comments stay muted — existing `syncComments` behavior)
10. Handle `isDeleted` from syncComments results
11. Update `lastGmailUpdateTimestamp` to now
12. Return `{ added, updated, deleted, unarchived, errorCount, comments }`

No labels or notes are applied (this is a refresh, not a load).

### Timestamp Lifecycle

The `lastGmailUpdateTimestamp` field in the Status table tracks the scan position.

```
No timestamp ──► Default (7 days ago) ──► Scan ──► Timestamp saved
                                                        │
                                                   Next refresh
                                                        │
                                                  Scan from saved timestamp
```

The timestamp is always updated after a successful scan, even if no docs were
found. This prevents re-scanning the same window on repeated clicks.

### UI

- Icon: same `RefreshCw` spinner as Refresh / Full Refresh
- Label: "Refresh from Gmail"
- Tooltip: "Check Gmail for doc notifications since last scan"
- Toast: "Gmail refresh — N new, N updated, N unarchived" with error count suffix
  if > 0 (e.g., "(3 errors)")
- Error toast: "Failed to refresh from Gmail"

---

## Comparison: Load vs Refresh from Gmail

| | Load dialog (Gmail source) | Refresh from Gmail button |
|---|---|---|
| **Trigger** | Open dialog, configure, scan, select, add | Single click |
| **User selection** | Yes — review and deselect docs | No — all discovered docs are upserted |
| **Labels/notes** | Can assign | None |
| **Time window** | User-specified `daysBack` | Saved `lastGmailUpdateTimestamp` (or 7 days) |
| **Unarchive** | Yes (via comment sync in the load POST) | Yes |
| **Deletion detection** | No (Load with Gmail source skips it) | Yes (`findDeletedDocIds` for missing docs) |
| **API route** | `POST /api/docs/scan` then `POST /api/docs?mode=load` | `POST /api/docs/gmail-refresh` |
