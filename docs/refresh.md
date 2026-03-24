# Refresh Flow

## Sync Modes

There are four sync modes, triggered from different UI paths:

| Mode | Trigger | Doc discovery | Deletion detection | Comment sync scope |
|------|---------|---------------|--------------------|--------------------|
| **Load** | Load dialog ([`load-dialog.md`](./load-dialog.md)) | `files.get` per selected doc | None (handled by Refresh) | Selected docs |
| **Refresh** | "Refresh" button | Drive `changes.list` + Gmail scan (parallel) | Drive changes feed + `findDeletedDocIds` for Gmail-only | Changed/discovered docs |
| **Full Refresh** | "Full Refresh" hamburger item | `fetchDocsByIds` for all docs | `findDeletedDocIds` for all docs | All docs in DB |
| **Source Refresh** | "Refresh from Drive/Gmail" hamburger items | Drive or Gmail only | Same as Refresh, for active source | Changed/discovered docs |
| **Refresh Selected** | "Refresh selected" hamburger item | `fetchDocsByIds` for filtered set | `findDeletedDocIds` for filtered set | Filtered docs |

All refresh modes (Refresh, Full Refresh, Refresh Selected, Source Refresh) flow through
a single `executeRefresh()` function in `src/lib/refresh.ts` with different options:

- **Refresh** (toolbar button): `POST /api/docs/refresh` → `executeRefresh({ drive: true, gmail: true })`
- **Source Refresh** (hamburger): same endpoint with `{ drive: true }` or `{ gmail: true }`
- **Full Refresh** (hamburger): `POST /api/docs?mode=full-refresh` → `executeRefresh({ googleDocIds: [...all], mode: "full-refresh" })`
- **Refresh Selected** (hamburger): `POST /api/docs/refresh-selected` → `executeRefresh({ googleDocIds: [...selected], mode: "selected" })`

When `googleDocIds` is provided, `executeRefresh` skips Drive/Gmail discovery and goes
straight to metadata fetch via `fetchDocsByIds`, then upsert + comment sync + deletion
detection. When `drive`/`gmail` booleans are set, it runs the full discovery phase
(changes.list, Gmail scan) in parallel.

**Load** still uses `POST /api/docs?mode=load` with its own load-specific logic. Per-doc
refresh (detail page) is separate — see below.

## Per-doc Refresh (detail page)

The doc detail page has its own **Refresh** button that calls `POST /api/docs/[docId]/refresh`.
This endpoint performs a unified fetch: after getting file metadata (`files.get`), it fetches
comments+threads and doc content in parallel — each Drive API is called once, and the results
feed both the DB sync and the client response. The endpoint returns the updated doc, comments,
thread map, suggestion content, document text, and `viewedByMeTime` all in one response, so
the client doesn't need separate `/comments` or `/content` fetches after refresh.

---

## Google Drive APIs Used

Docreview uses three distinct Google APIs for syncing:

### Drive API v3 — `files.list` (Scan + bootstrap)

Queries for Docs, Sheets, and Slides modified in a time window. Used by the Load dialog's
scan phase (`POST /api/docs/scan`) and as a bootstrap fallback when no changes page token
exists (Refresh with no prior sync). **Includes Shared Drives** when the `includeSharedDrives`
option is selected (uses `corpora: "allDrives"` and `includeItemsFromAllDrives: true`).

**Query:** `mimeType in (doc, sheet, slides) AND modifiedTime > cutoff AND trashed = false`
**Fields:** `id, name, mimeType, webViewLink, modifiedTime, createdTime, owners(me, displayName)`
**Pagination:** `pageSize: 1000`, follows `nextPageToken` until exhausted.

### Drive API v3 — `files.get` (Load mode)

Fetches metadata for specific docs by ID. Used by Load mode to get fresh metadata for the
user's selected docs (both Drive and Gmail sources). Always uses `supportsAllDrives: true`
to ensure Shared Drive docs are accessible.

### Drive API v3 — `changes.list` (Refresh / Full Refresh)

Returns all file-level mutations (edits, deletions, permission changes, renames, trashes)
since a saved page token. Purpose-built for incremental sync — cheap to poll when nothing
has changed. Always includes changes from **Shared Drives** (uses `includeItemsFromAllDrives: true`).

**Fields:** `removed, fileId, file(id, name, mimeType, webViewLink, modifiedTime, createdTime, owners(me, displayName), trashed)`
**Pagination:** `pageSize: 1000`, follows `nextPageToken` until `newStartPageToken` is returned.
**Deduplication:** Active editing produces multiple change entries per file. Results are
deduplicated by `fileId`, keeping the last entry per file.
**Filtering:** Only changes to supported MIME types (Docs, Sheets, Slides) are processed.
Changes with `removed: true` or `file.trashed: true` are treated as deletions.

### Drive API v3 — `changes.getStartPageToken`

Returns a token representing "now" — all future `changes.list` calls with this token will
return only changes that happen after it was issued. Called during bootstrap and after Load
to establish the baseline for future refreshes.

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
is saved for the next refresh. This includes changes from **Shared Drives** automatically.

**Expired token:** If `changes.list` returns a 404 (token too old or invalidated), the
handler falls back to bootstrap behavior: gets a fresh token and does a 7-day `listRecentDocs`
scan. A warning is logged.

**After Load / Add:** Load mode fetches docs by ID (not the changes feed). Direct URL/ID
additions also work this way. After a successful sync, `getStartPageToken` is called and saved.
This means subsequent Refresh operations use `changes.list` even if the user's first sync
was manual. Individual metadata fetches (`files.get`) always support Shared Drives
automatically.

**Transient errors:** If any comment sync has a transient error, the token is **not** updated.
This preserves the old token so the next Refresh re-processes any changes that may have been
partially handled.

---

## Progress Reporting (SSE)

Long-running operations (Refresh, Full Refresh, Load, Scan) use **Server-Sent Events (SSE)**
to report progress to the UI in real time.

- **Server-side:** `createProgressStream` (`src/lib/sse.ts`) wraps the operation. It provides
  a `send(event)` callback to the executor.
- **Client-side:** `fetchWithProgress` (`src/lib/stream-progress.ts`) reads the stream and
  dispatches events to `handleRefreshProgress`, which updates Sonner toasts.

### Progress Phases

Progress events track five distinct phases:

1.  **`drive` (Discovery):** Scanning the Drive changes feed or recent files.
    - Reports raw **changes** read from the API (e.g., "Scanning changes from Drive (4449 found)...").
2.  **`gmail` (Discovery):** Scanning Gmail notifications.
    - Reports messages scanned out of the total found (e.g., "Reading notifications from Gmail (12 of 50)...").
3.  **`metadata` (Processing):** Fetching Drive metadata for discovered or selected IDs.
    - Reports documents processed out of the total (e.g., "Fetching metadata for 5 of 1650 documents...").
4.  **`docs-updated` (Early UI refresh):** Emitted after all doc rows are upserted to the
    database but before comment/suggestion sync begins. The client uses this signal to fetch
    and display the updated docs list immediately, so the user sees metadata changes without
    waiting for the (potentially slow) comment sync to finish. No toast is shown for this event.
5.  **`sync` (Syncing):** Fetching and updating comments/suggestions from Drive/Docs APIs.
    - Reports documents synced out of the total (e.g., "Reading comments for 10 of 1650 documents...").

Once the stream ends, the final result is sent as a `result` event, and the UI displays
a document-focused summary (e.g., "Refresh complete — 1650 documents (2 new, 5 updated, 1 deleted)").

---

## Phase 1 — Doc Discovery

### Load mode: `files.get` per selected doc

**Drive call:** `files.get` for each doc ID the user selected in the Load dialog.
Only the selected docs are fetched — no broad listing.

### Refresh / Full Refresh: from the changes feed

Standard **Refresh** uses `changes.list` with the saved page token. Returns changed, deleted, and
trashed files since the token was issued.

If no saved token exists, or the token has expired, falls back to bootstrap behavior
(see Token Lifecycle above).

**Full Refresh** (since March 2026) skips the changes feed and instead performs an
exhaustive metadata fetch for all tracked document IDs in the database via `fetchDocsByIds`.
This ensures that any docs missed by the incremental changes feed (e.g., due to Drive API
edge cases) are eventually synchronized.


### Role detection (both paths)

`owners[].me === true` → `AUTHOR`; otherwise `REVIEWER`. This is Drive's own data about who
owns the file, not something we infer.

### Upsert logic (both paths)

For each file Drive returns:

- **New AUTHOR doc (not in DB, user owns it):** created with `role: "AUTHOR"` and
  `createdTimeInDrive` / `owner`. Default status is **ARCHIVED** to avoid "noise"
  from the Drive changes feed resurfacing old documents. A doc only moves to
  **INBOX** if it was also discovered via a Gmail notification (`fromGmail`)
  or if the subsequent comment sync (Phase 3) detects relevant activity
  that triggers a "Smart Unarchive".
- **New REVIEWER doc (not in DB, someone else owns it):** only added during **load** mode.
  Refresh and full-refresh skip these — reviewer docs must already be tracked in the DB or
  added manually via `/api/docs/add`. Default status is **ARCHIVED**.
- **Existing doc:** `driveUrl`, `mimeType`, `lastModifiedInDrive`, `owner`,
  `createdTimeInDrive`, and `accessState` are updated. `title` is cleared (titles
  are not stored in the DB — they're fetched on demand from Drive and cached in the
  browser; see `docs/local-storage-cache.md`). `role` and `labels` are
  never touched; they belong to the user. `status` is preserved (only updated
  via Gmail or Smart Unarchive triggers). Setting `accessState: "OK"` on upsert
  means a doc that re-appears in Drive (e.g., shared again) is automatically restored.

**What's preserved across refreshes:**
- `role` — user may override Drive's detection after first sync
- `status` — user archives/unarchives docs manually
- `labels` — user-assigned; Drive knows nothing about them

---

## Phase 2 — Deletion Detection

### Refresh / Source Refresh: from the changes feed

`changes.list` naturally reports deletions. A change with `removed: true` or
`file.trashed: true` is a deletion. The handler looks up matching non-deleted docs in the DB
and sets their `accessState` to `TRASHED` or `NOT_FOUND`. No extra API calls needed.

### Full Refresh / Refresh Selected: manual detection

These modes perform exhaustive `fetchDocsByIds` calls. If a document ID known to the
database is *not* returned in the metadata results, the system performs a final verification
via `findDeletedDocIds` (which checks for 404/403 responses on direct file gets). This
ensures the database stays in sync even when the changes feed is bypassed.

### Load mode: no deletion detection

Load mode only processes the specific docs the user selected — there is no "missing from
results" set to check. Deletion detection for tracked docs is handled by Refresh and
Full Refresh via the changes feed.

### Soft delete

`accessState` tracks file-level access. Non-OK docs stay in the database; the UI renders
them with strikethrough. This preserves user-set role, status, and labels even after a doc
is gone from Drive. If a doc re-appears in Drive (e.g., shared again), the upsert in Phase 1
resets `accessState` to `OK`. See [`access-states.md`](./access-states.md) for full details.

---

## Phase 3 — Comment Sync

Both the main Refresh and the per-doc Refresh run the same `syncComments` function
(`src/lib/sync-comments.ts`). The main Refresh processes docs in parallel (`Promise.all`);
the per-doc Refresh runs it for a single doc with pre-fetched data (comments and suggestions
already retrieved by the unified `fetchCommentData` + `fetchDocData` calls), so `syncComments`
skips its own API fetches and only does the DB sync.

**Comment sync scope by mode:**

| Mode | Which docs get comment sync |
|------|----------------------------|
| Load | Non-deleted selected docs |
| Refresh | Non-deleted docs returned by `changes.list` (changed docs only) |
| Full Refresh | All non-deleted docs in the DB |
| Refresh Selected | All non-deleted docs in the UI-filtered set |

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
of replies), plus `resolved`, `isThreadAuthor`, `isReplyAuthor`, `iResolvedIt`. All Drive API
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
detection, `isThreadAuthor` / `isReplyAuthor`), see [`comment-tracking.md`](./comment-tracking.md).
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

**Early update (during comment sync):** When the server emits the `docs-updated` SSE event
(after doc upserts, before comment sync), the client immediately fetches
`GET /api/docs?includeArchived=true` and updates the table. This lets the user see new,
updated, and deleted docs without waiting for comment/suggestion sync to finish. A sequence
counter (`fetchSeq`) guards against race conditions — if the early fetch resolves after the
final fetch, its result is discarded.

**Final update:** After `POST /api/docs/refresh` returns, the client fetches the docs list
again to pick up any changes from comment sync (e.g., Smart Unarchive moving docs from
ARCHIVED to INBOX). Both fetches include `includeArchived=true` so the client-side filter
in `DocTable` has the full set. Source-specific refreshes from the hamburger menu follow
the same pattern via `handleSourceRefresh`.

**Per-doc refresh:** The `POST /api/docs/[docId]/refresh` response includes the full updated doc
with its comments array, plus thread details, suggestion content, document text, and
`viewedByMeTime`. `DocDetail` destructures all of this from the response and updates state
directly — no follow-up `/comments` or `/content` fetches needed. The owner and modified date
in the header reflect the latest Drive data without a page reload. Titles are fetched
separately via the browser's title cache.

The main POST response includes summary counts (`added`, `updated`, `deleted`, `unarchived`,
`commentsCreated`, `commentsUpdated`, `suggestionsCreated`, `suggestionsUpdated`,
`skipNotAuthor`) which are used for logging and debugging.

---

## Transient Error Handling

`syncComments` catches Drive/Docs API errors per-doc so that a single doc's failure doesn't
crash the entire sync.

- **Permanent errors (404)** are treated as deletions. The doc is marked `accessState: "NOT_FOUND"`.
- **Expected permission errors (403)** are treated as successful skips. If the user lacks
  comment permission for a doc (common for view-only shared docs), comment sync is skipped
  for that doc. This is **not** considered a transient error and does **not** block the
  token update.
- **Transient errors** (429 rate limit, 500 server error, network timeouts) return
  `transientError: true`. This also applies when `fetchSuggestions` fails for unexpected
  reasons.

After all comment syncs complete, the POST handler checks whether any sync result had
`transientError: true`. If so, it **skips saving the changes page token**. This preserves the
old token so the next Refresh re-processes changes from the same point and re-attempts the
docs whose comment sync failed. A single `permissionDenied: true` (403) doc does not trigger
this skip on its own — but it does reduce the success count for the `allFailed` safety check
below.

### Systemic Failure Protection (`allFailed`)

As a safety measure, if a sync attempt includes one or more documents but **every single
document fetch fails** (due to transient errors, permission denied, or deletions), the sync
is treated as a systemic failure.

In this state:
- The Drive `driveChangesPageToken` is **not** updated.
- The Gmail `lastGmailUpdateTimestamp` is **not** updated.

This prevents the system from "skipping ahead" in the changes feed or Gmail window if a broad
issue (like a network outage or expired OAuth scope) is preventing access to all documents.
Permission-denied docs (typically from the Docs suggestions API returning 403) count as
failures here intentionally — the next refresh will retry, and if even one doc succeeds we
know the service is healthy and can safely advance the token.

---

## Comment Sync Recovery (Stale Comment Catch-up)

Doc metadata and comment sync are not atomic — a doc can be successfully upserted but its
comment sync may fail (transient API error, suggestion permission denied, network timeout).
When this happens, the doc exists in the database but its comments may be stale or missing.

### How staleness is tracked

`commentsLastSyncedAt` on the `Doc` record is stamped with the **sync start time** (not
completion time) when comment sync fully succeeds. This ensures that any changes arriving
during the sync window are covered by the next sync. The timestamp is only written when
**both** comments and suggestions complete successfully:

| Scenario | Stamp? | Rationale |
|----------|--------|-----------|
| Full success (comments + suggestions) | Yes | Everything synced |
| Non-Docs file (no suggestions to sync) | Yes | Comments are the only sync target |
| Comment fetch 404 (deleted) | No | Doc marked `NOT_FOUND`, excluded from stale query |
| Comment fetch 403 (permission denied) | Yes | Permissions rarely change; `lastModifiedInDrive` will trigger re-sync if they do |
| Comment fetch transient error | No | Worth retrying next refresh |
| Suggestion fetch 403 (permission denied) | Yes | Common for view-only docs; comments synced successfully |
| Suggestion fetch transient error | No | Worth retrying next refresh |

### How stale docs are caught up

During `executeRefresh`, a catch-up query runs **in parallel** with Drive and Gmail
discovery (no added latency). It finds all non-deleted docs where:

- `commentsLastSyncedAt IS NULL` — comments were never successfully synced (e.g., Add or
  Load followed by a transient API failure), or
- `commentsLastSyncedAt < lastModifiedInDrive` — the doc was modified in Drive after
  the last successful comment sync.

These doc IDs are deduplicated against the docs already discovered by Drive changes and
Gmail, then merged into the same metadata fetch and `upsertDocsAndSyncComments` pipeline.
There is no separate catch-up phase — stale docs flow through the same processing as
everything else.

### Paths that can produce stale docs

| Path | How it can fail | Recovery |
|------|----------------|----------|
| **Add** (`/api/docs/add`) | Doc created, `syncComments` hits transient error | `commentsLastSyncedAt` stays null; caught by next Refresh |
| **Re-add** (`/api/docs/[docId]/re-add`) | Transaction deletes old + creates new, `syncComments` fails outside transaction | Same as Add, but old comments are lost |
| **Load** (`POST /api/docs?mode=load`) | Docs upserted, comment sync fails for some | Same as Add |
| **Refresh** (Drive token held back) | `syncComments` transient error → Drive token not advanced | Doc reappears in next `changes.list` AND caught by stale query |

### Token holdback interaction

The stale catch-up is complementary to the existing Drive token holdback (see Transient
Error Handling above). Token holdback ensures that docs with transient errors during
Refresh reappear in the next `changes.list`. The stale catch-up additionally covers docs
that were added outside the changes feed (Add, Re-add, Load) where there is no token to
hold back.

---

## Server Logging

The sync handler and comment sync engine log structured messages at each stage. All log lines
use a `[Refresh]` or `[Comments]` prefix for easy filtering (previously `[Sync]`). Log messages
handle singular/plural forms correctly (e.g., "1 doc" vs "0 docs").

Sample output for a typical Refresh:

```
[Refresh] Starting refresh (sources: drive, gmail)
[Refresh] Drive: using changes.list with saved token
[Drive] changes.list (page abc123…) → 5 changes (142ms)
[Refresh] Ended changes.list sync: 3 changed docs, 1 total deletions reported by Drive
[Refresh] Syncing comments for 3 docs
[Drive] comments.list abc123 (since all) → 12 comments (87ms)
[Docs] documents.get abc123 → 2 suggestions (134ms)
[Comments] abc123: 12 comments from Drive (1 new, 3 updated, 0 deleted); 2 suggestions (0 new, 1 updated, 0 resolved)
[Drive] comments.list def456 (since all) → 3 comments (45ms)
[Comments] def456: 3 from Drive (0 new, 0 updated, 0 deleted)
[Drive] comments.list ghi789 (since all) → 8 comments (62ms)
[Docs] documents.get ghi789 → 0 suggestions (98ms)
[Comments] ghi789: 8 comments from Drive (2 new, 1 updated, 1 deleted); 0 suggestions (0 new, 1 updated, 1 resolved) → unarchive
[Refresh] Drive: 1 of 1 deletions were tracked docs
[Refresh] Saving changes token for future refreshes
[Refresh] Complete in 892ms: 5 Drive changes processed, 0 docs added, 3 docs updated, 1 doc deleted, 1 doc unarchived, 3 new comment threads, 4 updated comment threads, 2 new suggestions, 1 updated suggestion, 45 docs skipped (not author) (0 errors)
```

Key state transitions are logged:

| Log message | Meaning |
|-------------|---------|
| `no saved token, bootstrapping` | First refresh or token was cleared — falling back to 7-day files.list |
| `using changes.list with saved token` | Normal incremental refresh via changes feed |
| `changes.list token expired, falling back to bootstrap` | Saved token was too old; re-bootstrapping |
| `Load (drive): fetching metadata for N docs by ID` | Load mode fetching selected docs |
| `Ended changes.list sync: N changed docs, M total deletions` | Results from Drive changes feed |
| `Drive: X of Y deletions were tracked docs` | How many Drive-reported deletions affected our DB |
| `Saving changes token for future refreshes` | Token update after successful sync |
| `Load complete, initializing changes token` | Load mode establishing baseline for future Refresh |
| `Sync issues (errors: N), skipping timestamp update` | Gmail/Sync error prevented advancing the scan window |
| `→ unarchive` suffix on comment sync line | Doc will be moved from ARCHIVED back to INBOX |
| `N docs skipped (not author)` | Count of new discovered docs that were skipped because the user isn't the owner |
| `N Drive changes processed` | Total raw volume reported by the Drive API during discovery |

---

## OAuth Token Refresh

`getDriveClient` builds an `OAuth2Client` (from `google-auth-library`), seeded with the
`access_token`, `refresh_token`, and `expires_at` from the `Account` table. The auth library
handles token refresh automatically when the access token is expired.

When a new token is issued, the `OAuth2Client` emits a `"tokens"` event. The handler writes
the new `access_token` (and `refresh_token` if rotated) back to the `Account` table so the
next request doesn't need to refresh again.

`getDriveClient` is called once per refresh and the resulting client is reused for all phases
(doc discovery, comment sync), so at most one token refresh happens per
Refresh operation.
