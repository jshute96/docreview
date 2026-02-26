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

## Rules

- `docs/` has design docs.
  - This includes docs on any areas with non-trival logic or behavior.
  - Consult these docs as needed, and keep them up to date, describing the intended
    behavior in any non-trival cases.
  - Update `docs/file-index.md` when adding, renaming, or removing source files.
- Run tests before commit code.
- Write tests to cover all logic, where reasonable.
- Where code has subtle or suprising logic, add comments to explain it.
- Ask for human review before making database schema changes or manual data updates.
- `README.md` has setup and debugging commands. Keep that up to date.
- Don't run DDL or DML (updates or alters) on postgres without asking me.
  You can only run queries and other readonly commands.
