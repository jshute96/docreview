# Refresh Flow

When the user clicks **Refresh**, the client fires `POST /api/docs`, then immediately follows
with `GET /api/docs?includeArchived=true` to reload the full list. The server-side POST does
three things in sequence: sync the doc list from Drive, detect deletions, then sync comments.

---

## Phase 1 — Doc List Sync (`listRecentDocs`)

**Drive call:** `files.list` with a query that matches Docs, Sheets, and Slides modified in
the last 30 days and not trashed. `pageSize: 100`; paginates until `nextPageToken` is absent.

**Fields fetched:** `id, name, mimeType, webViewLink, modifiedTime, owners`

**Role detection:** `owners[].me === true` → `AUTHOR`; otherwise `REVIEWER`. This is Drive's
own data about who owns the file, not something we infer.

**Upsert logic:** for each file Drive returns:

- **New doc (not in DB):** created with Drive-detected role. Default status is `ACTIVE`.
- **Existing doc:** only `title`, `driveUrl`, `mimeType`, `lastModifiedInDrive`, and
  `isDeleted` are updated — and only when at least one of these has actually changed, or
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
complete. All docs are processed in parallel (`Promise.all`).

**Why not gate on file `modifiedTime`:** Drive does not update a file's `modifiedTime` when
comments change, so we cannot use it as a signal.

**Incremental sync:** each doc stores `commentsLastSyncedAt`. The Drive `comments.list` call
passes this as `startModifiedTime`, so Drive only returns comments modified since the last
sync. If nothing changed on a doc, the response is empty — the call is cheap.

For full details on comment status logic (ACTIVE / ARCHIVED / MUTED, who-resolved-it
detection, `isMine` / `iParticipated`), see [`comment-tracking.md`](./comment-tracking.md).

---

## Phase 4 — UI Update (no page reload)

After `POST /api/docs` returns, `RefreshButton` immediately calls
`GET /api/docs?includeArchived=true` to fetch the full updated doc list (including archived
docs, so the user's current filter state is respected by the client-side filter in `DocTable`
rather than being silently dropped).

The fresh list is passed to `DocTable` via the `onRefresh` callback, which calls
`setDocs(newDocs)` directly. No navigation, no server component re-render.

The POST response includes summary counts (`added`, `updated`, `deleted`) which are shown in a
toast: e.g., "Sync complete — 2 new, 1 updated". If nothing changed, the toast reads
"no updates".

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
