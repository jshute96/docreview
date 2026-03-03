# Refresh Flow

## Sync Modes

There are three sync modes, triggered from different UI paths:

| Mode | Trigger | Doc discovery | Deletion detection | Comment sync scope |
|------|---------|---------------|--------------------|--------------------|
| **Load** | Load dialog ([`load-dialog.md`](./load-dialog.md)) | `files.list` — configurable window | `files.get` per missing doc | Docs returned by Drive |
| **Refresh** | "Refresh" button | `changes.list` — incremental | Built into changes feed | Changed docs only |
| **Full Refresh** | "Full Refresh" button | `changes.list` — incremental | Built into changes feed | All docs (including deleted) |
| **Gmail Refresh** | "Refresh from Gmail" button ([`gmail.md`](./gmail.md)) | Gmail notification scan | `findDeletedDocIds` for missing docs | Upserted docs |

Load, Refresh, and Full Refresh share the same POST handler (`POST /api/docs?mode=...`).
Gmail Refresh has its own handler (`POST /api/docs/gmail-refresh`). Per-doc refresh
(detail page) is separate — see below.

## Per-doc Refresh (detail page)

The doc detail page has its own **Refresh** button that calls `POST /api/docs/[docId]/refresh`.
This fetches fresh file metadata from Drive (`files.get`), updates the doc record, then syncs
comments — all for that one doc — and returns the updated doc + comments in a single response.
No separate GET needed. Useful for quickly checking a single doc without waiting for a full
sync.

---

## Google Drive APIs Used

Docreview uses three distinct Google APIs for syncing:

### Drive API v3 — `files.list` (Load mode)

Queries for Docs, Sheets, and Slides modified in a time window. Used only by Load mode for
the initial broad scan.

**Query:** `mimeType in (doc, sheet, slides) AND modifiedTime > cutoff AND trashed = false`
**Fields:** `id, name, mimeType, webViewLink, modifiedTime, createdTime, owners(me, displayName)`
**Pagination:** `pageSize: 100`, follows `nextPageToken` until exhausted.

### Drive API v3 — `changes.list` (Refresh / Full Refresh)

Returns all file-level mutations (edits, deletions, permission changes, renames, trashes)
since a saved page token. Purpose-built for incremental sync — cheap to poll when nothing
has changed.

**Fields:** `removed, fileId, file(id, name, mimeType, webViewLink, modifiedTime, createdTime, owners(me, displayName), trashed)`
**Pagination:** `pageSize: 100`, follows `nextPageToken` until `newStartPageToken` is returned.
**Deduplication:** Active editing produces multiple change entries per file. Results are
deduplicated by `fileId`, keeping the last entry per file.
**Filtering:** Only changes to supported MIME types (Docs, Sheets, Slides) are processed.
Changes with `removed: true` or `file.trashed: true` are treated as deletions.

### Drive API v3 — `changes.getStartPageToken`

Returns a token representing "now" — all future `changes.list` calls with this token will
return only changes that happen after it was issued. Called during bootstrap and after Load
to establish the baseline for future refreshes.

### Drive API v3 — `files.get` (Load mode deletion checks)

Used only in Load mode to verify whether docs missing from the 30-day `files.list` window
are actually deleted. Not needed for Refresh/Full Refresh since the changes feed reports
deletions directly.

### Drive API v3 — `comments.list` / Docs API v1 — `documents.get`

Used for comment and suggestion sync. Covered in the Comment Sync section below.

---

## Changes Page Token Lifecycle

The `driveChangesPageToken` field in the `Status` table tracks the user's position in the
Drive changes feed. This is the key piece of state that determines how Refresh works.

```
No token ──► Bootstrap ──► Token saved ──► changes.list ──► New token saved
                                               │
                                          Token expired?
                                               │
                                           ▼ (404)
                                         Bootstrap
```

**No token (first use):** When no `driveChangesPageToken` exists, Refresh cannot use
`changes.list`. Instead it bootstraps: calls `getStartPageToken` to establish a baseline,
then falls back to `listRecentDocs` with a 7-day window to catch recent activity. The token
is saved for future refreshes.

**Normal refresh (saved token):** Calls `changes.list` with the saved token. Drive returns
all mutations since that token was issued. The response includes a `newStartPageToken` which
is saved for the next refresh.

**Expired token:** If `changes.list` returns a 404 (token too old or invalidated), the
handler falls back to bootstrap behavior: gets a fresh token and does a 7-day `listRecentDocs`
scan. A warning is logged.

**After Load:** Load mode uses `files.list` (not the changes feed), but after a successful
Load, `getStartPageToken` is called and saved. This means subsequent Refresh operations
use `changes.list` even if the user's first sync was a Load.

**Transient errors:** If any comment sync has a transient error, the token is **not** updated.
This preserves the old token so the next Refresh re-processes any changes that may have been
partially handled.

---

## Phase 1 — Doc Discovery

### Load mode: `files.list` (30-day scan)

**Drive call:** `files.list` with a query matching Docs, Sheets, and Slides modified in the
last 30 days and not trashed.

### Refresh / Full Refresh: `changes.list` (incremental)

**Drive call:** `changes.list` with the saved page token. Returns changed, deleted, and
trashed files since the token was issued.

If no saved token exists, or the token has expired, falls back to bootstrap behavior
(see Token Lifecycle above).

### Role detection (both paths)

`owners[].me === true` → `AUTHOR`; otherwise `REVIEWER`. This is Drive's own data about who
owns the file, not something we infer.

### Upsert logic (both paths)

For each file Drive returns:

- **New AUTHOR doc (not in DB, user owns it):** created with `role: "AUTHOR"` and
  `createdTimeInDrive` / `owner`. Default status is `INBOX`. This happens in all modes
  (load, refresh, full-refresh) so authored docs are auto-tracked.
- **New REVIEWER doc (not in DB, someone else owns it):** only added during **load** mode.
  Refresh and full-refresh skip these — reviewer docs must already be tracked in the DB or
  added manually via `/api/docs/add`.
- **Existing doc:** `title`, `driveUrl`, `mimeType`, `lastModifiedInDrive`, `owner`,
  `createdTimeInDrive`, and `isDeleted` are updated. `role` and `labels` are
  never touched; they belong to the user. `status` is only updated during **load**
  mode if the user specifies a status (via "Add to Inbox" or "Move to Inbox");
  otherwise it is preserved. Setting `isDeleted: false` on upsert means a doc
  that re-appears in Drive (e.g., shared again) is automatically restored.

**What's preserved across refreshes:**
- `role` — user may override Drive's detection after first sync
- `status` — user archives/unarchives docs manually
- `labels` — user-assigned; Drive knows nothing about them

---

## Phase 2 — Deletion Detection

### Refresh / Full Refresh: from the changes feed

`changes.list` naturally reports deletions. A change with `removed: true` or
`file.trashed: true` is a deletion. The handler looks up matching non-deleted docs in the DB
and marks them `isDeleted: true`. No extra API calls needed.

### Load mode: `findDeletedDocIds` fallback

A doc absent from the 30-day `files.list` is not necessarily deleted — it may simply not have
been modified recently. So we don't flag missing docs directly.

**Step 1:** Query the DB for INBOX, non-deleted docs whose `googleDocId` did not appear in
the Drive results.

**Step 2:** For each, call `files.get` with `fields: "trashed"`. All calls run in parallel
(`Promise.all`). Three outcomes:

| Drive response | Meaning | Action |
|---|---|---|
| `trashed: false` | File exists and is accessible | No change |
| `trashed: true` | File is in the trash | `isDeleted = true` |
| HTTP 404 / 403 | Permanently deleted or access revoked | `isDeleted = true` |

### Soft delete

`isDeleted` is a soft-delete flag. The doc stays in the database; the UI renders it with
strikethrough. This preserves user-set role, status, and labels even after a doc is gone from
Drive. If a doc re-appears in Drive (e.g., shared again), the upsert in Phase 1 clears
`isDeleted`.

---

## Phase 3 — Comment Sync

Both the main Refresh and the per-doc Refresh run the same `syncComments` function
(`src/lib/sync-comments.ts`). The main Refresh processes docs in parallel (`Promise.all`);
the per-doc Refresh runs it for a single doc.

**Comment sync scope by mode:**

| Mode | Which docs get comment sync |
|------|----------------------------|
| Load | Non-deleted docs returned by Drive |
| Refresh | Non-deleted docs returned by `changes.list` (changed docs only) |
| Full Refresh | All docs in the DB (including deleted ones, so they can recover from temporary 403 errors) |

**Why not gate on file `modifiedTime`:** Drive does not update a file's `modifiedTime` when
comments change, so we cannot use it as a signal.

**Full scan (no `startModifiedTime`):** Every sync performs a full `comments.list` scan.
Drive API's `startModifiedTime` filter silently excludes suggestions, so incremental syncs
were dropped entirely.

**Batch fetch & no-op detection:** All existing comments for the doc are loaded in a single
`findMany` query (avoiding N+1 `findUnique` calls). Before writing each update, Drive fields
are compared against the existing record; if nothing changed, the update is skipped. This
makes the "N updated" log count reflect actual writes.

**Bulk inserts:** New comments are collected during the loop and inserted with a single
`createMany` call rather than individual `create` calls. This collapses N `INSERT` statements
into one `INSERT ... VALUES (...)`, reducing round-trips and Postgres parse/plan/execute
overhead. Most beneficial on initial doc load when many comments exist; after that, new
comments typically trickle in one or two at a time.

**Fields fetched per comment:** `id, resolved, createdTime, modifiedTime, author(me), replies(action, author(me))`

**Fields stored per comment:** `driveCreatedAt`, `driveModifiedAt`, `replyCount` (= number
of replies), plus `resolved`, `isThreadAuthor`, `iParticipated`, `iResolvedIt`. All Drive API
results are stored as `type: "COMMENT"`.

**Deleted comment cleanup:** After processing all Drive results, any COMMENT records in the DB
whose `googleCommentId` was not returned by Drive are deleted. We don't store comment text
in the database (it's fetched from Drive on page load), so orphaned records have nothing
useful to show. This runs regardless of
comment status (INBOX, ARCHIVED, MUTED). It is safe from transient errors because
`fetchComments` either returns a complete paginated result or throws — and if it throws, we
return early before reaching the deletion code.

**Suggestions via Docs API:** For Google Docs files, a second pass calls `documents.get`
via the Docs API to capture all pending suggestions. These are stored as `type: "SUGGESTION"`
with `suggest.xxx` IDs. New suggestions are bulk-inserted with `createMany` (like comments).
Existing suggestions are only updated if `suggestionType` changed (which is rare), and
skipped entirely otherwise — no write at all. Any previously-active suggestion no longer
returned by the Docs API is marked resolved.

For full details on comment status logic (INBOX / ARCHIVED / MUTED, who-resolved-it
detection, `isThreadAuthor` / `iParticipated`), see [`comment-tracking.md`](./comment-tracking.md).
For the full picture on suggestions specifically, see [`suggestions.md`](./suggestions.md).

---

## Phase 3.5 — Smart Unarchive

After comment sync completes, each doc's sync result includes a `shouldUnarchive` flag
indicating whether meaningful new activity was detected. ARCHIVED docs are moved back to
INBOX only when this flag is true — not merely because they have unresolved comments.

See [Doc Unarchive Rules](./comment-tracking.md#doc-unarchive-rules) for the full logic
(`isInteresting` check, MUTED handling, self-resolved exceptions).

---

## Phase 4 — UI Update (no page reload)

**Main refresh:** After `POST /api/docs` returns, `RefreshButton` immediately calls
`GET /api/docs?includeArchived=true` to fetch the full updated doc list (including archived
docs, so the user's current filter state is respected by the client-side filter in `DocTable`
rather than being silently dropped). The fresh list is passed to `DocTable` via the
`onRefresh` callback, which calls `setDocs(newDocs)` directly.

**Per-doc refresh:** The `POST /api/docs/[docId]/refresh` response includes the full updated doc
with its comments array. `DocDetail` calls `setDoc(updated)` and `setComments(updated.comments)`
directly, so the title, owner, and modified date in the header also reflect the latest Drive
data without a page reload.

The main POST response includes summary counts (`added`, `updated`, `deleted`, `comments`)
which are shown in a toast: e.g., "Sync complete — 2 new, 1 updated". If nothing changed,
the toast reads "no updates".

---

## Transient Error Handling

`syncComments` catches Drive/Docs API errors per-doc so that a single doc's failure doesn't
crash the entire sync. Permanent errors (404, 403) are treated as deletions. Transient errors
(429 rate limit, 500 server error, network timeouts) return `transientError: true` instead —
this also applies when `fetchSuggestions` fails, which skips the suggestion resolution logic
to avoid incorrectly marking live suggestions as resolved.

After all comment syncs complete, the POST handler checks whether any sync result had
`transientError: true`. If so, it **skips saving the changes page token**. This preserves the
old token so the next Refresh re-processes changes from the same point and re-attempts the
docs whose comment sync failed.

---

## Server Logging

The sync handler and comment sync engine log structured messages at each stage. All log lines
use a `[Sync]` or `[Comments]` prefix for easy filtering. Sample output for a typical
Refresh:

```
[Sync] Starting refresh sync
[Sync] refresh: using changes.list with saved token
[Drive] changes.list (page abc123…) → 5 changes (142ms)
[Sync] changes.list → 3 changed docs, 1 deletions
[Sync] Doc found: Project Spec (abc123)
[Sync] Doc found: Meeting Notes (def456)
[Sync] Doc found: Design Doc (ghi789)
[Sync] Processing 1 deletions from changes.list
[Sync] Syncing comments for 3 docs (changed docs only)
[Drive] comments.list abc123 (since all) → 12 comments (87ms)
[Docs] documents.get abc123 → 2 suggestions (134ms)
[Comments] abc123: 12 comments from Drive, 1 new, 3 updated, 0 deleted; 2 suggestions (0 new, 0 updated, 0 resolved)
[Drive] comments.list def456 (since all) → 3 comments (45ms)
[Comments] def456: 3 from Drive, 0 new, 0 updated, 0 deleted
[Drive] comments.list ghi789 (since all) → 8 comments (62ms)
[Docs] documents.get ghi789 → 0 suggestions (98ms)
[Comments] ghi789: 8 comments from Drive, 2 new, 1 updated, 1 deleted; 0 suggestions (0 new, 0 updated, 1 resolved) → unarchive
[Sync] Saving changes token for future refreshes
[Sync] refresh complete in 892ms: 0 added, 3 updated, 1 deleted, 1 unarchived, 3 comments synced
```

Key state transitions are logged:

| Log message | Meaning |
|-------------|---------|
| `no saved token, bootstrapping` | First refresh or token was cleared — falling back to 7-day files.list |
| `using changes.list with saved token` | Normal incremental refresh via changes feed |
| `changes.list token expired, falling back to bootstrap` | Saved token was too old; re-bootstrapping |
| `Load: scanning via files.list (30-day window)` | Load mode using broad files.list scan |
| `Processing N deletions from changes.list` | Deletions detected in the changes feed |
| `Load: checking N docs not in Drive results for deletion` | Load mode checking missing docs individually |
| `Saving changes token for future refreshes` | Token update after successful sync |
| `Load complete, initializing changes token` | Load mode establishing baseline for future Refresh |
| `Transient errors during comment sync, skipping token update` | Token preserved due to partial failure |
| `→ unarchive` suffix on comment sync line | Doc will be moved from ARCHIVED back to INBOX |

---

## OAuth Token Refresh

`getDriveClient` builds a `google.auth.OAuth2` client, seeded with the `access_token`,
`refresh_token`, and `expires_at` from the `Account` table. The googleapis library handles
token refresh automatically when the access token is expired.

When a new token is issued, the `OAuth2Client` emits a `"tokens"` event. The handler writes
the new `access_token` (and `refresh_token` if rotated) back to the `Account` table so the
next request doesn't need to refresh again.

`getDriveClient` is called once per refresh and the resulting client is reused for all phases
(doc discovery, deletion checks, comment sync), so at most one token refresh happens per
Refresh operation.
