# Refresh Flow

## Main Refresh (all docs)

When the user clicks **Refresh** on the docs list, the client fires `POST /api/docs`, then
immediately follows with `GET /api/docs?includeArchived=true` to reload the full list. The
server-side POST does three things in sequence: sync the doc list from Drive, detect
deletions, then sync comments.

## Per-doc Refresh (detail page)

The doc detail page has its own **Refresh** button that calls `POST /api/docs/[id]/refresh`.
This syncs comments for only that one doc and returns the updated doc + comments in a single
response — no separate GET needed. Useful for quickly checking a single doc without waiting
for a full sync.

---

## Phase 1 — Doc List Sync (`listRecentDocs`)

**Drive call:** `files.list` with a query that matches Docs, Sheets, and Slides modified in
the last 30 days and not trashed. `pageSize: 100`; paginates until `nextPageToken` is absent.

**Fields fetched:** `id, name, mimeType, webViewLink, modifiedTime, createdTime, owners(me, displayName)`

**Role detection:** `owners[].me === true` → `AUTHOR`; otherwise `REVIEWER`. This is Drive's
own data about who owns the file, not something we infer.

**Upsert logic:** for each file Drive returns:

- **New doc (not in DB):** created with Drive-detected role and `createdTimeInDrive` /
  `owner`. Default status is `ACTIVE`.
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

Comment threads are synced for every non-deleted doc after the doc list and deletion checks
complete. All docs are processed in parallel (`Promise.all`). The per-doc refresh runs the
same `syncComments` logic for a single doc.

**Why not gate on file `modifiedTime`:** Drive does not update a file's `modifiedTime` when
comments change, so we cannot use it as a signal.

**Full scan (no `startModifiedTime`):** unlike the older incremental approach, the per-doc
Refresh always performs a full `comments.list` scan. This is required because Drive API's
`startModifiedTime` filter silently excludes suggestion-type comment threads, which would
cause pending suggestions to disappear after the first sync.

**Fields fetched per comment:** `id, resolved, createdTime, modifiedTime, author(me), replies(action, author(me)), anchor`

**Fields stored per comment:** `driveCreatedAt`, `driveModifiedAt`, `replyCount` (= number
of replies), plus `resolved`, `isMine`, `iParticipated`, `iResolvedIt`, `type`
(COMMENT/SUGGESTION), and `suggestionType` (INSERT/DELETE/EDIT). All are updated on both
create and update paths, including the MUTED path.

**Suggestions require a second sync pass:** `comments.list` only surfaces some pending
suggestions as Drive comments. To capture all pending suggestions, a second pass calls
`documents.get` via the Docs API. The two syncs produce records with different ID formats
(`AAAB0xxx` vs `suggest.xxx`) and coexist in the Comment table.

For full details on comment status logic (ACTIVE / ARCHIVED / MUTED, who-resolved-it
detection, `isMine` / `iParticipated`), see [`comment-tracking.md`](./comment-tracking.md).
For the full picture on suggestions specifically, see [`suggestions.md`](./suggestions.md).

---

## Phase 4 — UI Update (no page reload)

**Main refresh:** after `POST /api/docs` returns, `RefreshButton` immediately calls
`GET /api/docs?includeArchived=true` to fetch the full updated doc list (including archived
docs, so the user's current filter state is respected by the client-side filter in `DocTable`
rather than being silently dropped). The fresh list is passed to `DocTable` via the
`onRefresh` callback, which calls `setDocs(newDocs)` directly.

**Per-doc refresh:** the `POST /api/docs/[id]/refresh` response includes the full updated doc
with its comments array. `DocDetail` calls `setComments(updated.comments)` directly.

The main POST response includes summary counts (`added`, `updated`, `deleted`, `comments`)
which are shown in a toast: e.g., "Sync complete — 2 new, 1 updated". If nothing changed,
the toast reads "no updates".

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
