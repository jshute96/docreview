# AGENTS.md

This file provides guidance to agents when working with code in this
repository. See `README.md` for setup instructions and available commands.

## Running Commands

Node 20 is required (provided by nvm via `~/.profile`).

After any schema change, restart the dev server — Next.js holds the Prisma client in memory
and won't pick up the regenerated client until restart.

## Architecture

See `docs/*.md` for detailed architecture docs — keep them in sync with behavior changes:
- `docs/architecture.md` — high-level system architecture overview
- `docs/file-index.md` — one-line descriptions of every source file, grouped by layer
- `docs/refresh.md` — full refresh flow (Drive sync, deletion detection, comment sync, UI update)
- `docs/comment-tracking.md` — comment status logic, unarchive rules, filter behavior
- `docs/suggestions.md` — suggestion sync via Docs API, limitations

**Offline mode:** `OFFLINE_MODE=true` disables Google OAuth/API — see `src/lib/offline.ts`.
Uses CredentialsProvider + JWT sessions. `getDriveClient()` throws `OfflineModeError`.

**Schema notes:** PostgreSQL is required. Enum types are used for `Doc.role`, `Doc.status`,
`Comment.type`, `Comment.suggestionType`, and `Comment.status`. Prisma 5 is pinned (Prisma 7
dropped `url = env(...)` support in schema.prisma).

## Workflow Rules

- **Documentation**:
    - Keep `docs/*.md` design documents in sync with behavioral changes.
    - Update `docs/file-index.md` when adding, renaming, or removing source files.
    - When adding or changing user-facing functionality, review and update the help pages in `public/help/*.md` to keep them accurate. See `public/help/pages.json` for the page list.
- **Database Safety**:
    - Ask for human review before making database schema changes or manual data updates.
    - Never run DDL or DML (updates/alters) directly on PostgreSQL; use Prisma migrations or ask for permission to run these.
    - **Querying**: Use `scripts/query_database.sh` for read-only queries. It connects via a readonly PostgreSQL user (`docreview_ro`) so it cannot accidentally modify data.
      ```bash
      scripts/query_database.sh "SELECT count(*) FROM docs"
      scripts/query_database.sh -x "SELECT * FROM docs LIMIT 3"  # expanded display
      scripts/query_database.sh --schema                         # all table schemas
      scripts/query_database.sh --schema comments                # one table's schema
      scripts/query_database.sh -f query.sql                     # from file
      ```
- **Commit Preparation**:
  - Run `npm test` and `npm run typecheck` before committing code.
  - Ensure `README.md` is updated if setup or debugging commands change.
  - Include all significant changes in the commit message.

## Development Conventions

### Authentication & Authorization
- **Consistency**: Always use `getValidSession()` or `requireAuth()` from `src/lib/auth-utils.ts` instead of raw `auth()` calls to ensure consistency between online and offline modes.
- **Server Components**: For protected pages in the App Router, call `requireAuth()` at the top of the Server Component.

### Database
- **Prisma**: Prisma 5 is pinned; do not upgrade to Prisma 7 without verifying support for `url = env(...)` in the schema.
- **State**: Schema changes or regeneration of the Prisma client require a dev server restart, as Next.js holds the client in memory.

### Testing
- **Coverage**: Write tests for all non-trivial logic.
- **Mocks**: Mock the Prisma client using the provided `src/lib/__mocks__/prisma.ts`.
- This project uses **Vitest**.

### UI Controls
- **Tooltips**: All buttons, filter controls, and column headings should have a `title` attribute providing a brief description of what the control does. When adding new controls, always include a tooltip. For toggle buttons with two states (e.g., Archive/Unarchive), use a dynamic title that reflects the current action.

### Cross-Tab Live Sync
- **Every page** must use `useCrossTabListener` from `src/lib/cross-tab.ts` to stay in sync when other tabs broadcast changes (label edits, doc adds, etc.).
- When a page mutates shared data (docs, labels, comments), call `broadcastChange()` so other open tabs refresh.
- The listener callback should re-fetch the data the page depends on (e.g., `/api/labels` for the add page, both `/api/docs` and `/api/labels` for the doc list).
- When adding a new page, verify cross-tab sync works: open the page in two tabs, make a change in one, and confirm the other updates.

### Google Drive API Error Handling
- **API routes**: Every catch block around Drive API calls must check `invalidGrantResponse(err)` from `google-drive.ts` before returning a generic 502. This returns a 401 with a clear reauth message when the OAuth token has expired.
- **Client components**: Use `apiFetch()` from `src/lib/api-fetch.ts` instead of raw `fetch()` for any request to a Drive-backed API route. It intercepts 401 responses, shows a single deduplicated reauth toast, and throws `ApiAuthError`.
- **Catch blocks**: When a catch block shows a `toast.error`, guard it with `if (!isAuthError(err))` so generic error toasts are suppressed when the real cause is an expired token — otherwise the user sees duplicate/confusing toasts.

### Logging
- **Errors:** Use `logError(message, ...args)` from `src/lib/log.ts` — prints red with `ERROR:` prefix via `console.error`.
- **Warnings:** Use `logWarning(message, ...args)` from `src/lib/log.ts` — prints yellow with `WARNING:` prefix via `console.warn`.
- **Info:** Use `logInfo(message, ...args)` from `src/lib/log.ts` — wraps `console.log` and writes to daily log files.
- **Never** use raw `console.log()`, `console.error()`, or `console.warn()` in application code; always use the helpers in `log.ts`.
- **Prefix** every log message with a bracketed tag: `[Drive]`, `[Gmail]`, `[Sync]`, `[Comments]`, `[Suggestions]`, `[Scan]`, `[Refresh]`, `[Prisma]`, `[Auth]`, `[API]`, `[GmailRefresh]`, `[Docs]`.
- **Include timing** for external API calls: `(${Date.now() - t0}ms)`.
- Client-side toasts don't need corresponding `console.log` — the server-side API route already logs the operation or error.
- **File logging:** All log calls also write to `logs/docreview-YYYY-MM-DD.log` (PST dates). Each line has format: `TIMESTAMP REQUEST_ID LEVEL MESSAGE args`. Log files auto-rotate daily and are cleaned up after 14 days. `logSilent(message, ...args)` writes to the file only (no console output).
- **Request IDs:** Every API route handler must be wrapped in `runWithRequestId("METHOD", req, async () => { ... })` from `src/lib/request-context.ts`. This extracts the URL and client context ID from the request, assigns an 8-char hex ID that tags all log lines within that request. When adding a new route handler, always add this wrapper.
- **Reading logs for debugging:** Use `tail -50 logs/docreview-*.log` to see recent log messages. To trace a single request, find its 8-char ID and `grep` for it: `grep 'a1b2c3d4' logs/docreview-*.log`. To find errors: `grep 'ERROR' logs/docreview-*.log`. To see all activity for a tag: `grep '\[Sync\]' logs/docreview-*.log`.

### Code Logic
- **Documentation**: Where code has subtle or surprising logic, add comments to explain the "why" and intended behavior.

## Planning vs Implementation
When the user asks you to implement something, start coding quickly. Do NOT
spend the entire session planning unless explicitly asked for a plan. If a plan
is needed, keep it concise (bullet points, not paragraphs) and confirm with the
user before elaborating further. Default to action over planning.

## Git & Commits
- When committing, include ALL relevant changed files — check `git status` before committing to avoid missing files like TODO.md, documentation, or new files.
- Always update the file index (if one exists) when adding or renaming files.

## Code Changes
- Use the file index to help find relevant files.
- When changing behavior, read existing design docs to understand previous designs and intentions.  Ask questions if unsure if we should change those requirements.
- When the user asks for a change, apply it consistently to ALL similar patterns (e.g., if optimizing bulk inserts for comments, also apply to suggestions).
- Do NOT drop or overwrite existing content in files like README.md — preserve what's there and add to it.
