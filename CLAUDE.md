# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Node 20 is required. Always source nvm before running any command:
```bash
. /home/jshute/.nvm/nvm.sh && nvm use 20
```

```bash
npm run dev       # start dev server at http://localhost:3000
npm run build     # production build (also runs type checking)
npm run lint      # ESLint
npx tsc --noEmit  # type check without building

npx prisma migrate dev --name <name>  # create and apply a migration
npx prisma studio                     # open DB browser at http://localhost:5555
npx prisma generate                   # regenerate client after schema changes
```

## Environment

`.env` requires:
```
DATABASE_URL="file:./prisma/dev.db"
AUTH_SECRET="..."         # generate with: npx auth secret
AUTH_GOOGLE_ID="..."
AUTH_GOOGLE_SECRET="..."
```

Google Cloud: OAuth redirect URI must be `http://localhost:3000/api/auth/callback/google`. Drive API and `drive.readonly` scope must be enabled. Your Google account must be added as a test user.

## Architecture

**Auth flow:** `src/auth.ts` exports `{ handlers, auth, signIn, signOut }` from NextAuth v5. The `auth()` function works in both server components and API routes. `PrismaAdapter` persists sessions and OAuth tokens to SQLite. The `Account` table stores the Google `access_token` and `refresh_token` needed for Drive API calls.

**Google Drive sync:** `src/lib/google-drive.ts` reads tokens from the `Account` table, builds an `OAuth2Client`, and registers a `tokens` event to write refreshed tokens back to the DB. `listRecentDocs()` queries docs modified in the last 30 days and auto-detects role: `owners[].me === true` → AUTHOR, else REVIEWER.

**Data flow:** `POST /api/docs` calls `listRecentDocs()` and upserts results — new docs get default role/status, existing docs only get title and `lastModifiedInDrive` updated (preserving user-set metadata). `PATCH /api/docs/[id]` handles role, status, and label assignments in one call (labels are replaced wholesale via `deleteMany` + `create`).

**UI state:** `docs/page.tsx` is a server component that fetches initial data and passes it to `DocTable` (client component). All filter state (`showArchived`, `selectedLabelIds`) and optimistic doc list updates live in `DocTable`. Mutations in `DocRow` and `EditDocDialog` call the API then invoke `onUpdate`/`onArchive` callbacks to update parent state — no full page reload except after Drive sync (which calls `router.refresh()`).

**Schema notes:** SQLite doesn't support enums — `Doc.role` and `Doc.status` are `String` fields with string defaults (`"REVIEWER"`, `"ACTIVE"`). Valid values are `AUTHOR`/`REVIEWER` and `ACTIVE`/`ARCHIVED`. Prisma 5 is pinned (Prisma 7 dropped `url = env(...)` support in schema.prisma).
