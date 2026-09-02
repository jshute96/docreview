# API Routes

All API routes live under `src/app/api/`. Every route uses `runWithRequestId()` for
request-level logging and `getValidSession()` for authentication. Routes that call
Google APIs check `invalidGrantResponse()` to return 401 on expired tokens.

## Documents

### `/api/docs` — Doc list and load

| Method | Purpose | Google API? |
|--------|---------|-------------|
| GET | List all tracked docs with comments | No (Prisma) |
| POST | Selective load — adds scanned docs with labels/notes | Drive (SSE streaming) |

POST Body: `{ source, selectedGoogleDocIds, labelIds, notes, docNotes?, status?, isStarred?, inaccessibleDocs? }`

- `docNotes`: Optional `Record<googleDocId, string>` for document-specific notes (e.g. share messages from Gmail). Appended to any generic `notes` provided.

### `/api/docs/[docId]` — Single doc CRUD

| Method | Purpose | Google API? |
|--------|---------|-------------|
| GET | Fetch doc with all comments | No (Prisma) |
| PATCH | Update role, status, labels, notes, starred | No (Prisma) |
| DELETE | Remove doc and its comments | No (Prisma) |

### `/api/docs/scan` — Drive/Gmail scan

POST. Scans Drive or Gmail for recent docs the user touched. Returns results as
SSE with `isNew` flag per doc. Used by the Load dialog's scan phase.

Body: `{ daysBack?, ownership?, includeSharedDrives?, source? }`

Google API: Drive or Gmail.

### `/api/docs/validate` — URL validation

GET `?url=...`. Resolves shortened links, fetches Drive metadata, checks whether
the doc is already tracked. Used by the Add dialog to preview a URL before adding.

Google API: Drive.

### `/api/docs/add` — Add single doc

POST. Adds a new doc (or updates existing) from a URL. Used by the standalone
Add page and Add dialog.

Google API: Drive.

### `/api/docs/metadata` — Bulk metadata refresh

POST `{ googleDocIds: string[] }`. Fetches current titles and owners from Drive
for up to 100 docs (10 concurrent). Used by the Bulk Edit dialog to show fresh
titles.

Google API: Drive.

### `/api/docs/bulk-update` — Bulk edit

PATCH. Updates multiple docs at once — role, status, starred, labels, notes.
Uses tri-state apply rules (`"as-is"`, `"set"`, `"clear"`).

No Google API (Prisma only).

### `/api/docs/refresh` — Refresh (streaming)

POST. Three modes controlled by the request body:

- **Discovery mode** (default): `{ sources: ["drive", "gmail"] }`. Uses Drive
  changes API and Gmail scan to discover what changed, then syncs.
- **Full mode**: `{ mode: "full" }`. Fetches metadata for every tracked doc
  directly by ID, bypassing discovery. Used for exhaustive re-sync.
- **Selected mode**: `{ docIds: ["d1", ...] }`. Same as full mode but only
  refreshes the specified docs (by DB ID).

Google API: Drive, Docs, Gmail.

### `/api/docs/[docId]/re-add` — Re-add deleted doc

POST. Re-adds a previously deleted doc with fresh Drive metadata.

Google API: Drive.

### `/api/docs/[docId]/refresh` — Single-doc refresh

POST. Full refresh of one doc — fetches metadata, comments, suggestions, and
document text in parallel. Returns everything the client needs to update both
the comment list and expanded thread panels without additional fetches.

Google API: Drive, Docs.

### `/api/docs/[docId]/viewed-time` — Update viewed time

PUT `{ viewedByMeTime: string }`. Stamps the doc's `viewedByMeTime` in Drive
so Google treats it as recently viewed.

Google API: Drive.

## Comments and Threads

### `/api/docs/[docId]/comments` — Bulk comment updates

PATCH only. Bulk-updates comment `status` or `isRead` for multiple comments.

Body: `{ commentIds: string[], status?: CommentStatus, isRead?: boolean }`

The `isRead` boolean is stored as a message count (`readMessageCount`) — true means every
known message in the thread, false means none. See docs/comment-tracking.md#read-tracking.

No Google API (Prisma only).

### `/api/docs/[docId]/comments/[commentId]` — Single comment update

PATCH. Updates a single comment's `status`, `isRead`, or `isStarred` in the
database (`isRead` is stored as a message count — see the bulk route above).
Auto-unarchives the parent doc if a comment moves to INBOX.

No Google API (Prisma only).

### `/api/docs/[docId]/threads` — Thread data from Drive

| Method | Purpose | Google API? |
|--------|---------|-------------|
| GET | Fetch threads from Drive | Yes (Drive) |
| POST | Refresh single thread with DB sync (`?commentId=X`) | Yes (Drive or Docs) |

GET modes:
- No params: fetches all threads + `viewedByMeTime` (page load, cross-tab)
- `?commentId=X`: fetches one thread
- `?commentId=X&checkOnly=true`: returns just `modifiedTime` (staleness check)

All responses return threads as `Record<id, CommentThread>`.

POST with `?commentId=X` forces a fresh fetch and syncs the DB comment record.
Returns `{ comment, threads }`.

### `/api/docs/[docId]/threads/reply` — Reply to thread

POST `{ commentId, content?, resolve? }`. Posts a reply, optionally resolving
or reopening the thread. Pins `viewedByMeTime` before and after to prevent
Drive from auto-marking the doc as viewed.

Google API: Drive.

### `/api/docs/[docId]/threads/edit` — Edit or delete a comment

`PATCH { commentId, replyId?, content }` edits the text of a comment or one of
its replies. `DELETE { commentId, replyId? }` deletes a reply, or the whole
thread when `replyId` is omitted. Both pin `viewedByMeTime` like the reply
route.

Drive only permits these on entries the signed-in user authored, so a Drive 403
is returned as a 403 with an ownership message rather than a generic 502, and a
Drive 404 (already deleted) as a 404.

Editing and deleting a reply re-sync the thread and return `{ comment, threads }`.
Deleting the whole thread deletes the `Comment` record and returns
`{ deleted: true }`.

Suggestions are rejected with a 400 — the Docs API has no edit or delete for
them (see `docs/suggestions.md`).

Google API: Drive.

### `/api/docs/[docId]/extension-suggestions` — Extension suggestion merge

POST `{ suggestions: ExtensionSuggestionInput[] }`. Receives suggestion data
scraped from the Google Docs DOM by the Chrome extension and merges it into the
database using content-hash matching (same algorithm as Gmail merge). Returns
`{ success, result: { merged, inserted, updated, resolved, skipped }, comments }`
where `comments` is the full list of suggestion records for the doc after merging.
Auto-unarchives the parent doc if a suggestion moves to INBOX.

`skipped` counts suggestions dropped because their disco ID was missing or
malformed — see "Missing disco IDs are transient, never placeholders" in
`comment-tracking.md`. A fully-skipped payload still returns 200: a partial DOM
scrape is a transient condition the page recovers from on the next fetch, not a
client error.

No Google API (Prisma only).

### `/api/docs/sync-comments/[googleDocId]` — Extension-triggered sync

POST. Called by the Chrome extension when it detects comment activity on a doc.
Accepts optional hints `{ commentType?, googleCommentId? }` to narrow the sync
scope. Auto-unarchives the parent doc if a comment or suggestion moves to INBOX.

Google API: Drive, Docs.

### Comparison: comments vs threads

| Endpoint | Used by | Calls Google? | What it does |
|----------|---------|---------------|--------------|
| `PATCH /comments` | doc-detail bulk actions | No | Bulk-updates status/isRead for multiple comments in DB |
| `PATCH /comments/[id]` | comment-row (archive, star, read) | No | Updates one comment in DB — cheapest path for local-only changes |
| `GET /threads` | doc-detail page load, cross-tab handler | Yes (Drive) | Fetches all threads as Record + `viewedByMeTime` |
| `GET /threads?commentId=X` | comment-row expand, cross-tab (targeted) | Yes (Drive) | Fetches one thread as Record |
| `POST /threads?commentId=X` | comment-row Refresh button | Yes (Drive) | Syncs single thread to DB, returns updated comment + thread |
| `GET /threads?checkOnly=true` | comment-row background check | Yes (Drive) | Lightweight — just checks `modifiedTime` |

## Labels

### `/api/labels` — Label CRUD

| Method | Purpose | Google API? |
|--------|---------|-------------|
| GET | List all labels ordered by position | No (Prisma) |
| POST `{ name, color? }` | Create a new label | No (Prisma) |

### `/api/labels/[labelId]` — Single label

| Method | Purpose | Google API? |
|--------|---------|-------------|
| GET | Fetch label with doc count | No (Prisma) |
| PATCH `{ color? }` | Update label color | No (Prisma) |
| DELETE | Remove label | No (Prisma) |

### `/api/labels/reorder` — Reorder labels

PATCH `{ order: string[] }`. Sets label positions from an array of label IDs.

No Google API (Prisma only).

## User

### `/api/help-seen` — Dismiss help modal

POST. Records that the user has seen the help dialog.

No Google API (Prisma only).

### `/api/user/delete-all-data` — Delete user data

DELETE `{ deleteAccount: boolean }`. If `deleteAccount` is true, deletes the
user row (cascading to all data). If false, keeps user/account/session but
removes all docs, labels, and comments.

No Google API (Prisma only).

## Authentication

### `/api/auth/[nextauth]` — NextAuth handlers

GET, POST. Standard NextAuth.js OAuth and session management endpoints.

Google API: Google OAuth (via NextAuth).
