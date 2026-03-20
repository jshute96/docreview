# Architecture

Docreview is a single-user web application for tracking Google Docs and Slides
that you're reviewing or authoring. It monitors comments, suggestions, and
sharing activity across your documents so you can manage review work from one
place instead of digging through Gmail notifications and Drive.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | Next.js 16 (App Router), React 19 |
| Database | PostgreSQL, Prisma 5 ORM |
| Authentication | NextAuth v5, Google OAuth |
| Google APIs | Drive (file metadata, comments, threads), Docs (suggestions), Gmail (notification scanning) |
| UI | Tailwind CSS 4, Radix UI primitives (via shadcn/ui), Lucide icons, Sonner toasts |
| Deployment | `output: "standalone"` for containerized deployment |

## System Architecture

Docreview uses a server-centric architecture. The server handles all Google API
communication, authentication, and business logic. The client is a thin React
UI that only talks to the server's own REST API — it never contacts Google
directly.

```
┌─────────────┐       REST / SSE        ┌──────────────┐      Google APIs      ┌─────────────┐
│   Browser    │  ◄──────────────────►   │  Next.js     │  ◄────────────────►   │  Google      │
│  (React UI)  │    /api/* endpoints     │  Server      │   Drive, Docs, Gmail  │  Cloud       │
└─────────────┘                          └──────┬───────┘                       └─────────────┘
                                                │
                                                ▼
                                         ┌──────────────┐
                                         │  PostgreSQL   │
                                         │  (Prisma)     │
                                         └──────────────┘
```

There are no WebSockets, no webhooks from Google, and no background jobs. All
Google data is fetched on-demand when the user triggers a refresh or scan.

## Data Model

The PostgreSQL database has eight tables managed by Prisma. See
[`prisma/schema.prisma`](../prisma/schema.prisma) for the full schema.

**Authentication tables** (managed by NextAuth):
- **User** — identity (name, email, image)
- **Account** — OAuth provider link; stores Google access/refresh tokens
- **Session** — browser session mappings

**Application tables:**
- **Doc** — a tracked Google document or presentation. Key fields: `googleDocId`,
  `role` (Author/Reviewer), `status` (Inbox/Archived), `accessState`
  (OK/Trashed/Not Found/Denied), comment sync timestamp, notes, starred flag.
- **Comment** — a comment thread or suggestion synced from Google. Tracks
  `type` (Comment/Suggestion), `resolved` status, author flags (`isThreadAuthor`,
  `isReplyAuthor`), user state (`isRead`, `isStarred`, `status`), and suggestion
  metadata (`suggestionType`: Insert/Delete/Edit).
- **Label** — user-defined color-coded labels with drag-reorderable positions.
- **DocLabel** — many-to-many join between Docs and Labels.
- **Status** — per-user sync state: Drive changes page token and Gmail scan
  timestamp for incremental sync.

## API Layer

The server exposes ~19 REST endpoints under `/api/`, all requiring
authentication. See [`docs/file-index.md`](./file-index.md) for the full list.

**Document endpoints** (`/api/docs/*`):
- CRUD operations (list with filters, get, update, delete)
- Refresh and sync (full refresh, source-specific, per-doc, selected docs)
- Scan (discover docs from Drive/Gmail without committing to DB)
- Add (by URL, with validation), bulk update (up to 500 docs)

**Comment endpoints** (`/api/docs/[docId]/comments/*`, `/api/docs/[docId]/threads/*`):
- Fetch and update comment status, read state, stars
- Fetch thread details, post replies, resolve/reopen threads

**Label endpoints** (`/api/labels/*`):
- CRUD operations, reorder by position

Every mutation verifies that the authenticated user owns the resource being
modified. Enum values are validated against Prisma enums. Bulk operations verify
ownership of all targeted documents.

## Authentication and Security

Authentication uses NextAuth v5 with Google OAuth. See [`docs/auth.md`](./auth.md)
for details.

**Key properties:**
- Google OAuth tokens are stored in the `Account` table and never sent to the
  client. The server uses them for Google API calls and auto-refreshes expired
  access tokens via `google-auth-library`.
- Sessions are stored in PostgreSQL (database strategy). The browser holds only
  a secure httpOnly session cookie.
- An optional `ALLOWED_EMAILS` whitelist restricts sign-ups.
- An offline development mode (`OFFLINE_MODE=true`) bypasses Google OAuth and
  uses a credentials provider with JWT sessions.

**Trust model:** The client can request actions on resources it owns, but the
server independently verifies ownership and validates all inputs. The client
never has access to Google tokens or other users' data.

## Redirect Resolution

When adding documents by URL, users may provide shortened redirect URLs (e.g., `go/my-doc`). Docreview employs a two-tier resolution strategy:

1.  **Server-side Fallback:** The `/api/docs/validate` endpoint first attempts to follow redirects using a standard server-side `fetch` with `redirect: "follow"`. This works for public redirectors but fails for those requiring browser-based authentication.
2.  **Extension-based Resolution:** If the server-side check fails and the Chrome extension is installed, the client initiates resolution via the extension bridge. The extension follows the redirect in a background tab, leveraging the user's active browser session and cookies to resolve auth-walled shorteners.

Once a final Google Drive URL is obtained, it is re-validated against the Drive API to extract the canonical file ID and metadata.

## Data Sync

Documents enter the system through three paths:

1. **Manual add** — user pastes a Google Doc/Slides URL; server validates via
   Drive API and creates a DB record.
2. **Drive changes feed** — `changes.list` API returns documents modified since
   the last sync, identified by a stored page token.
3. **Gmail scanning** — queries Gmail for comment notification and sharing
   emails, extracts document IDs from email bodies.

The **refresh engine** (`src/lib/refresh.ts`) orchestrates sync across these
sources. Multiple refresh modes share a single `executeRefresh()` function with
different options. See [`docs/refresh.md`](./refresh.md) for the full flow.

**Comment sync** (`src/lib/sync-comments.ts`) fetches comment threads from the
Drive API and suggestions from the Docs API, then reconciles them with the
database — creating, updating, and deleting records as needed. Comment status
transitions (inbox/archived/muted) follow rules documented in
[`docs/comment-tracking.md`](./comment-tracking.md) and
[`docs/inbox-states.md`](./inbox-states.md).

## Client Architecture

The client consists of ~35 `"use client"` React components in `src/components/`.
Pages are server components that fetch initial data and render client components.

**API communication:** All client-to-server calls go through `apiFetch()`
(`src/lib/api-fetch.ts`), a fetch wrapper that adds request context IDs for log
correlation and intercepts 401 responses to trigger reauth toasts.

**Long-running operations:** Refresh and scan operations use Server-Sent Events
(SSE). The server streams progress events via `createProgressStream()`
(`src/lib/sse.ts`), and the client reads them with `fetchWithProgress()`
(`src/lib/stream-progress.ts`), mapping events to toast notifications.

**State management:** The client maintains transient UI state only — filter
selections, dialog state, optimistic updates. The only React context is
`LabelProvider` (`src/contexts/label-context.tsx`), which caches the label list.
All authoritative state lives in the database; the client fetches fresh data on
page load and after mutations.

**Cross-tab sync:** `BroadcastChannel` (`src/lib/cross-tab.ts`) notifies other
open tabs when shared data changes (doc adds, label edits, etc.), prompting them
to re-fetch. See [`docs/cross-tab.md`](./cross-tab.md).

**Browser-side caching:** Document titles are not stored in the database for
privacy. Instead, they're cached in `localStorage` and fetched on demand from
Google Drive. To avoid a flash of "Unknown title" during SSR hydration, the two
pages that display titles (`docs/page.tsx` and `comments/[docId]/page.tsx`) hide
the page body (`visibility:hidden`) and include inline `<script>` tags that
pre-read cached titles for their doc IDs into
`window.__docrTitleCache`. After React hydrates, a `useLayoutEffect` in
`useCachedTitles` populates title state and removes the hiding style — so the
page appears with titles already in place. A 2-second fallback removes the
hiding style if the hook never runs (e.g. JS error). See
[`docs/local-storage-cache.md`](./local-storage-cache.md).

## Observability

**Logging:** All server-side logging goes through `logError()`, `logWarning()`,
and `logInfo()` in `src/lib/log.ts`. Messages are tagged with a bracketed
prefix (`[Drive]`, `[Sync]`, `[Auth]`, etc.) and include timing for external
API calls. Logs write to both the console and daily rotating log files in
`logs/` (14-day retention).

**Request tracing:** Every API route handler is wrapped in
`runWithRequestId()` (`src/lib/request-context.ts`), which assigns an 8-character
hex ID via `AsyncLocalStorage`. All log lines within a request include this ID,
making it easy to trace a single request's activity across log files. Client
requests also send a context ID header for cross-request correlation.

## Related Docs

| Doc | Topic |
|-----|-------|
| [`file-index.md`](./file-index.md) | One-line descriptions of every source file |
| [`refresh.md`](./refresh.md) | Refresh flow — Drive sync, deletion detection, comment sync |
| [`comment-tracking.md`](./comment-tracking.md) | Comment status logic, unarchive rules, filters |
| [`inbox-states.md`](./inbox-states.md) | Inbox/Archived/Muted state transitions |
| [`suggestions.md`](./suggestions.md) | Suggestion sync via Docs API |
| [`gmail.md`](./gmail.md) | Gmail scanner internals, timestamp lifecycle |
| [`auth.md`](./auth.md) | Authentication — NextAuth, token refresh |
| [`cross-tab.md`](./cross-tab.md) | Cross-tab sync via BroadcastChannel |
| [`bulk-edit.md`](./bulk-edit.md) | Bulk editing logic and UI |
| [`load-dialog.md`](./load-dialog.md) | Load dialog scan→add flow |
| [`local-storage-cache.md`](./local-storage-cache.md) | Browser localStorage cache for titles — privacy model, SSR workarounds |
