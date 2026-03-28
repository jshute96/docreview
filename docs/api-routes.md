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

These four endpoints serve different purposes for comment data — see the
comparison table below.

### `/api/docs/[docId]/comments` — Thread list from Drive

| Method | Purpose | Google API? |
|--------|---------|-------------|
| GET | Fetch all comment threads (or single via `?commentId=X`) | Drive (`comments.list`) |
| PATCH | Bulk update comment status or isRead | No (Prisma) |

GET calls Drive `comments.list` to fetch thread data, builds a `threadMap`
keyed by comment ID, and returns `viewedByMeTime`. With `?commentId=X`, fetches
only that one thread. With `?checkOnly=true`, returns just the doc's
`modifiedTime` for staleness checks.

PATCH accepts `{ commentIds, status?, isRead? }` for bulk operations (e.g.,
"archive all resolved").

### `/api/docs/[docId]/comments/[commentId]` — Single comment update

PATCH. Updates a single comment's `status`, `isRead`, or `isStarred` in the
database. Auto-unarchives the parent doc if a comment moves to INBOX.

No Google API (Prisma only).

### `/api/docs/[docId]/threads` — Thread detail

| Method | Purpose | Google API? |
|--------|---------|-------------|
| GET | Fetch all threads or single thread (`?commentId=X`) | Drive |
| POST | Fetch single thread with sync (`?commentId=X`) | Drive |

GET without `?commentId` fetches all threads (used on initial page load).
GET with `?commentId=X` fetches one thread. POST with `?commentId=X` does the
same but forces a fresh fetch from Drive (used by the Refresh button on an
expanded comment). With `?checkOnly=true`, returns just `modifiedTime`.

### `/api/docs/[docId]/threads/reply` — Reply to thread

POST `{ commentId, content?, resolve? }`. Posts a reply, optionally resolving
or reopening the thread. Pins `viewedByMeTime` before and after to prevent
Drive from auto-marking the doc as viewed.

Google API: Drive.

### `/api/docs/sync-comments/[googleDocId]` — Extension-triggered sync

POST. Called by the Chrome extension when it detects comment activity on a doc.
Accepts optional hints `{ commentType?, googleCommentId? }` to narrow the sync
scope.

Google API: Drive, Docs.

### Comparison: comments vs threads vs comments/[id]

These endpoints handle overlapping concerns. Here's when each is used:

| Endpoint | Used by | Calls Google? | What it does |
|----------|---------|---------------|--------------|
| `GET /comments` | doc-detail page load, cross-tab handler | Yes (Drive) | Fetches all thread data via `comments.list`, returns `threadMap` |
| `GET /comments?commentId=X` | doc-detail cross-tab (targeted) | Yes (Drive) | Fetches one thread from the full `comments.list` response |
| `PATCH /comments` | doc-detail bulk actions | No | Bulk-updates status/isRead for multiple comments in DB |
| `PATCH /comments/[id]` | comment-row (archive, star, read) | No | Updates one comment in DB — cheapest path for local-only changes |
| `GET /threads` | doc-detail initial load | Yes (Drive) | Fetches all threads (same Drive call as `/comments` GET) |
| `GET /threads?commentId=X` | comment-row expand | Yes (Drive) | Fetches one thread detail |
| `POST /threads?commentId=X` | comment-row Refresh button | Yes (Drive) | Forces fresh single-thread fetch from Drive |
| `GET /threads?checkOnly=true` | comment-row background check | Yes (Drive) | Lightweight — just checks `modifiedTime` |

**Why two thread-fetching endpoints?** `/comments` is used by the page-level
cross-tab handler which needs to merge thread data into the full `threadMap`
and update `viewedByMeTime`. `/threads` is used by individual `CommentRow`
components for on-demand single-thread operations (expand, refresh,
background staleness check).

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

### `/api/auth/[...nextauth]` — NextAuth handlers

GET, POST. Standard NextAuth.js OAuth and session management endpoints.

Google API: Google OAuth (via NextAuth).
