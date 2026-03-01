# Refresh Flow

## Main Refresh (all docs)

When the user clicks **Refresh** on the docs list, the client fires `POST /api/docs`, then
immediately follows with `GET /api/docs?includeArchived=true` to reload the full list. The
server-side POST does three things in sequence: sync the doc list from Drive, detect
deletions, then sync comments.

## Per-doc Refresh (detail page)

The doc detail page has its own **Refresh** button that calls `POST /api/docs/[id]/refresh`.
This fetches fresh file metadata from Drive (`files.get`), updates the doc record, then syncs
comments — all for that one doc — and returns the updated doc + comments in a single response.
No separate GET needed. Useful for quickly checking a single doc without waiting for a full
sync.

---

## Phase 1 — Doc List Sync (`listRecentDocs`)

**Drive call:** `files.list` with a query that matches Docs, Sheets, and Slides modified in
the last 30 days and not trashed. `pageSize: 100`; paginates until `nextPageToken` is absent.

**Fields fetched:** `id, name, mimeType, webViewLink, modifiedTime, createdTime, owners(me, displayName)`

**Role detection:** `owners[].me === true` → `AUTHOR`; otherwise `REVIEWER`. This is Drive's
own data about who owns the file, not something we infer.

**Upsert logic:** for each file Drive returns:

- **New AUTHOR doc (not in DB, user owns it):** created with `role: "AUTHOR"` and
  `createdTimeInDrive` / `owner`. Default status is `ACTIVE`. This happens in all modes
  (load, refresh, full-refresh) so authored docs are auto-tracked.
- **New REVIEWER doc (not in DB, someone else owns it):** only added during **load** mode
  (initial page load). Refresh and full-refresh skip these — reviewer docs must already be
  tracked in the DB or added manually via `/api/docs/add`.
- **Existing doc:** `title`, `driveUrl`, `mimeType`, `lastModifiedInDrive`, `owner`,
  `createdTimeInDrive`, and `isDeleted` are updated when at least one has changed or
  `isDeleted` was true (re-appeared in Drive means access was restored). `role`, `status`,
  and `labels` are never touched; they belong to the user.

**What's preserved across refreshes:**
- `role` — user may override Drive's detection after first sync
- `status` — user archives/unarchives docs manually
- `labels` — user-assigned; Drive knows nothing about them

---

## Phase 2 — Deletion Detection (`findDeletedDocIds`)

A doc absent from the 30-day list is not necessarily deleted — it may simply not have been
modified recently. So we don't flag missing docs directly.

**Step 1:** query the DB for ACTIVE, non-deleted docs whose `googleDocId` did not appear in
the Drive list results.

**Step 2:** for each such doc, call `files.get` with `fields: "trashed"`. All calls run in
parallel (`Promise.all`). Three outcomes:

| Drive response | Meaning | Action |
|---|---|---|
| `trashed: false` | File exists and is accessible | No change |
| `trashed: true` | File is in the trash | `isDeleted = true` |
| HTTP 404 / any error | File was permanently deleted or access revoked | `isDeleted = true` |

**`isDeleted`** is a soft-delete flag. The doc stays in the database; the UI renders it with
strikethrough. This preserves user-set role, status, and labels even after a doc is gone from
Drive. If a doc re-appears in Drive (e.g., shared again), the upsert in Phase 1 clears
`isDeleted`.

---

## Phase 3 — Comment Sync

Both the main Refresh and the per-doc Refresh run the same `syncComments` function
(`src/lib/sync-comments.ts`). The main Refresh processes docs in parallel (`Promise.all`);
the per-doc Refresh runs it for a single doc. In **full-refresh** mode, all docs are synced
(including previously deleted ones, so they can recover from temporary 403 errors). In
**refresh** and **load** modes, only non-deleted docs scoped to the current Drive results
are synced.

**Why not gate on file `modifiedTime`:** Drive does not update a file's `modifiedTime` when
comments change, so we cannot use it as a signal.

**Full scan (no `startModifiedTime`):** every sync performs a full `comments.list` scan.
Drive API's `startModifiedTime` filter silently excludes suggestions, so incremental syncs
were dropped entirely.

**Fields fetched per comment:** `id, resolved, createdTime, modifiedTime, author(me), replies(action, author(me))`

**Fields stored per comment:** `driveCreatedAt`, `driveModifiedAt`, `replyCount` (= number
of replies), plus `resolved`, `isThreadAuthor`, `iParticipated`, `iResolvedIt`. All Drive API
results are stored as `type: "COMMENT"`.

**Suggestions via Docs API:** for Google Docs files, a second pass calls `documents.get`
via the Docs API to capture all pending suggestions. These are stored as `type: "SUGGESTION"`
with `suggest.xxx` IDs. Any previously-active suggestion no longer returned by the Docs API
is marked resolved — this runs even when the Docs API returns zero suggestions.

For full details on comment status logic (ACTIVE / ARCHIVED / MUTED, who-resolved-it
detection, `isThreadAuthor` / `iParticipated`), see [`comment-tracking.md`](./comment-tracking.md).
For the full picture on suggestions specifically, see [`suggestions.md`](./suggestions.md).

---

## Phase 3.5 — Smart Unarchive

After comment sync completes, each doc's sync result includes a `shouldUnarchive` flag
indicating whether meaningful new activity was detected. ARCHIVED docs are moved back to
ACTIVE only when this flag is true — not merely because they have unresolved comments.

See [Doc Unarchive Rules](./comment-tracking.md#doc-unarchive-rules) for the full logic
(`isInteresting` check, MUTED handling, self-resolved exceptions).

---

## Phase 4 — UI Update (no page reload)

**Main refresh:** after `POST /api/docs` returns, `RefreshButton` immediately calls
`GET /api/docs?includeArchived=true` to fetch the full updated doc list (including archived
docs, so the user's current filter state is respected by the client-side filter in `DocTable`
rather than being silently dropped). The fresh list is passed to `DocTable` via the
`onRefresh` callback, which calls `setDocs(newDocs)` directly.

**Per-doc refresh:** the `POST /api/docs/[id]/refresh` response includes the full updated doc
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
`transientError: true`. If so, it **skips** `updateDriveTimestamp`, keeping the old
`lastDriveUpdateTimestamp`. This means the next refresh will use the same `since` window and
re-attempt the docs whose comment sync failed.

---

## OAuth Token Refresh

`getDriveClient` builds a `google.auth.OAuth2` client, seeded with the `access_token`,
`refresh_token`, and `expires_at` from the `Account` table. The googleapis library handles
token refresh automatically when the access token is expired.

When a new token is issued, the `OAuth2Client` emits a `"tokens"` event. The handler writes
the new `access_token` (and `refresh_token` if rotated) back to the `Account` table so the
next request doesn't need to refresh again.

`getDriveClient` is called once per refresh and the resulting client is reused for all three
phases (doc list, deletion checks, comment sync), so at most one token refresh happens per
Refresh operation.
