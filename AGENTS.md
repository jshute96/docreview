# AGENTS.md

This file provides guidance to agents when working with code in this
repository. See `README.md` for setup instructions and available commands.

## Running Commands

Node 20 is required (provided by nvm via `~/.profile`).

After any schema change, restart the dev server — Next.js holds the Prisma client in memory
and won't pick up the regenerated client until restart.

## Architecture

See `docs/*.md` for detailed architecture docs — keep them in sync with behavior changes:
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
- **Database Safety**:
    - Ask for human review before making database schema changes or manual data updates.
    - Never run DDL or DML (updates/alters) directly on PostgreSQL; use Prisma migrations or ask for permission to run these.
- **Commit Preparation**:
  - Run `npm test` before committing code.
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

### UI Controls
- **Tooltips**: All buttons, filter controls, and column headings should have a `title` attribute providing a brief description of what the control does. When adding new controls, always include a tooltip. For toggle buttons with two states (e.g., Archive/Unarchive), use a dynamic title that reflects the current action.

### Cross-Tab Live Sync
- **Every page** must use `useCrossTabListener` from `src/lib/cross-tab.ts` to stay in sync when other tabs broadcast changes (label edits, doc adds, etc.).
- When a page mutates shared data (docs, labels, comments), call `broadcastChange()` so other open tabs refresh.
- The listener callback should re-fetch the data the page depends on (e.g., `/api/labels` for the add page, both `/api/docs` and `/api/labels` for the doc list).
- When adding a new page, verify cross-tab sync works: open the page in two tabs, make a change in one, and confirm the other updates.

### Code Logic
- **Documentation**: Where code has subtle or surprising logic, add comments to explain the "why" and intended behavior.
