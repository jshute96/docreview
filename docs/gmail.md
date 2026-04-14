# Gmail Integration

Gmail is used to discover Google Docs that the user has interacted with via
notification emails. There are three ways Gmail scanning is triggered:

1. **Refresh button** — combined Drive+Gmail sync: scans both sources in parallel,
   merges results, upserts all discovered docs automatically
2. **Refresh from Gmail** (hamburger menu) — Gmail-only sync via the same combined
   engine with `sources: ["gmail"]`
3. **Load dialog** — user-initiated, selective: scan Gmail, review results, choose
   which docs to add (see [`load-dialog.md`](./load-dialog.md))

The combined refresh engine (`src/lib/refresh.ts`) uses `scanGmailForDocIds()` from
`src/lib/gmail.ts` to get doc IDs without fetching Drive metadata (avoiding
double-fetch when Drive has already returned metadata for the same docs). The Load
dialog scan route still uses the full `scanGmailNotifications()` wrapper.

---

## Scanner — `scanGmailForDocIds(userId, since)`

The low-level scanner accepts a `Date` and returns `{ docIds, shareNotes, emailMeta, errorCount }`.
It performs only Gmail API calls (no Drive metadata fetch). The `emailMeta` map captures
per-doc metadata (subject, from, date, body) for use when Drive API fails — see
[Inaccessible Docs from Gmail](./access-states.md#inaccessible-docs-from-gmail).

The convenience wrapper `scanGmailNotifications()` calls it then fetches Drive metadata,
returning `{ docs: GmailScanDoc[], inaccessibleDocs: GmailInaccessibleDoc[], shareNotes, errorCount }`.
Docs that return 404/403 from Drive are included in `inaccessibleDocs` with best-effort
title and notes extracted from the email.

### Steps

1. Queries Gmail for messages from the two notification sender addresses, filtered
   by `after:YYYY/MM/DD` (day-level precision from the `since` Date):
   - `drive-shares-dm-noreply@google.com` (sharing notifications)
   - `comments-noreply@docs.google.com` (comment notifications)
2. Fetches each message (`format: "full"`) to extract headers and body
3. Filters by `internalDate >= since` for timestamp-level precision — the Gmail
   `after:` operator only has day-level granularity, so repeated calls within the
   same day would reprocess messages without this check
4. Skips sharing notifications that are confirmations of our own shares — detected
   by matching the `Reply-To` email against the logged-in user's email
5. Parses the plaintext body with regex to find a `/d/DOC_ID/` pattern
6. For sharing emails (from `drive-shares-dm-noreply@google.com`), extracts a share
   note via `parseShareNote()` in `gmail-parse.ts` — includes sharer name/email from
   Reply-To, date, and any custom message from the plaintext body. Distinguishes
   share invitations ("Shared by") from access requests ("Requested to share by")
   based on the Subject header.
7. For messages with a doc ID, calls Drive `files.get` to fetch real title,
   mimeType, webViewLink, and role
8. Messages with no doc link are logged as errors and counted
9. Docs that fail Drive fetch (404/403) are collected as `inaccessibleDocs` with
   best-effort metadata from the email
10. Deduplicates by googleDocId (multiple emails may reference the same doc)
11. Returns `{ docs, inaccessibleDocs, shareNotes, errorCount }` — `docs` contains
    successfully resolved docs; `inaccessibleDocs` contains docs that failed Drive fetch

### Share Note Extraction — `gmail-parse.ts`

When a sharing email is detected (From: `drive-shares-dm-noreply@google.com`),
`parseShareNote()` builds a note string from email headers and body:

- **Sharer**: extracted from `Reply-To` header (e.g., `"Jeff Shute <jshute@google.com>"`)
- **Date**: from `Date` header, formatted via `formatDate(date, true)` (PST, no seconds)
- **Message**: extracted structurally from the plaintext body — the URL paragraph is
  found (language-independent), the next paragraph (locale-dependent boilerplate) is
  skipped, and everything remaining is the custom share message

Output format: `"Shared by Name (email) on YYYY-MM-DD HH:MM\ncustom message"` for
invitations, or `"Requested to share by Name (email) on YYYY-MM-DD HH:MM"` for
access requests (detected via "share request" in the Subject header).

For **new docs**, the share note is set as the initial `notes` value in the upsert
create block. For **existing docs**, it is appended via `appendNotes()`. Existing
ARCHIVED docs are also unarchived to INBOX.

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

## Combined Refresh (Drive + Gmail)

The toolbar **Refresh** button calls `POST /api/docs/refresh` with
`sources: ["drive", "gmail"]`, running both sources in parallel via
`executeRefresh()` in `src/lib/refresh.ts`. The hamburger menu offers
source-specific refreshes ("Refresh from Drive", "Refresh from Gmail") using
the same endpoint with a single source. All refresh modes (including Full
Refresh and Refresh Selected) flow through the same `executeRefresh()` function
with different options — see [`refresh.md`](./refresh.md) for the full architecture.

### Flow — `executeRefresh({ drive, gmail, onProgress })`

1. `getDriveClient()` + `getStatus()` (shared setup)
2. **Discovery phase** (parallel via `Promise.all`):
   - Drive (if active): `changes.list` with saved token, fallback to `listRecentDocs`
   - Gmail (if active): `scanGmailForDocIds(userId, since)` → doc IDs only
3. **Merge**: build `driveDocMap`, compute `gmailOnlyIds` (Gmail IDs not in Drive results)
4. **Single metadata fetch**: `fetchDocsByIds` for Gmail-only IDs (no double-fetch)
5. **Upsert loop**: Gmail-sourced new docs always INBOX; Drive-only new non-AUTHOR docs skipped
6. **Share notes**: for sharing emails, a note is set (new docs) or appended (existing docs)
   with format `"Shared by Name (email) on DATE\nmessage"` (or `"Requested to share by..."`
   for access requests). Existing ARCHIVED docs are unarchived to INBOX — a (re)share is
   a strong signal the doc needs attention.
7. **Deletions**: Drive `changes.list` deletions + `findDeletedDocIds` for missing Gmail docs
8. **Comment sync** + **unarchive** for all upserted/updated docs
9. **Gmail comment merge**: for docs where Drive can't list comments (`noCommentsPermission`
   in the email), `mergeCommentsFromGmail()` inserts comment records from the parsed email
   body. Runs in both the upsert loop (step 8) and a second pass for docs that didn't go
   through upsert (inaccessible/failed-fetch docs). Triggers unarchive with cutoff check.
10. **Save tokens**: Drive token if Drive succeeded (and no transient errors); Gmail timestamp if Gmail succeeded

### Timestamp Lifecycle

The `lastGmailUpdateTimestamp` field in the Status table tracks the Gmail scan position.

```
No timestamp ──► Default (7 days ago) ──► Scan ──► Timestamp saved
                                                        │
                                                   Next refresh
                                                        │
                                                  Scan from saved timestamp
```

The timestamp is always updated after a successful Gmail scan, even if no docs were
found. This prevents re-scanning the same window on repeated clicks.

### UI

- **Refresh button** (toolbar): scans both Drive and Gmail
  - Toast: "Refresh complete — N new, N updated..." with error count suffix
- **Refresh from Drive** (hamburger): Drive-only scan
  - Toast: "Drive refresh complete — ..."
- **Refresh from Gmail** (hamburger): Gmail-only scan
  - Toast: "Gmail refresh complete — ..."

---

## Comparison: Load vs Refresh

| | Load dialog (Gmail source) | Refresh (combined or Gmail-only) |
|---|---|---|
| **Trigger** | Open dialog, configure, scan, select, add | Single click (toolbar or hamburger) |
| **User selection** | Yes — review and deselect docs | No — all discovered docs are upserted |
| **Labels/notes** | Can assign | None |
| **Time window** | User-specified `daysBack` | Saved `lastGmailUpdateTimestamp` (or 7 days) |
| **Unarchive** | Yes (via comment sync in the load POST) | Yes |
| **Deletion detection** | No (Load with Gmail source skips it) | Yes (`findDeletedDocIds` for missing docs) |
| **API route** | `POST /api/docs/scan` then `POST /api/docs?mode=load` | `POST /api/docs/refresh` |
