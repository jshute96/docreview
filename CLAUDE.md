# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

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

After any schema change, restart the dev server — Next.js holds the Prisma client in memory
and won't pick up the regenerated client until restart.

## Environment

`.env` requires:
```
DATABASE_URL="file:./prisma/dev.db"
AUTH_SECRET="..."         # generate with: npx auth secret
AUTH_GOOGLE_ID="..."
AUTH_GOOGLE_SECRET="..."
```

Google Cloud: OAuth redirect URI must be `http://localhost:3000/api/auth/callback/google`.
Drive API and `drive.readonly` scope must be enabled. Your Google account must be added as a
test user.

## Architecture

See `docs/*.md` for detailed architecture docs — keep them in sync with behavior changes:
- `docs/refresh.md` — full refresh flow (Drive sync, deletion detection, comment sync, UI update)
- `docs/comment-tracking.md` — comment status logic, unarchive rules, filter behavior
- `docs/suggestions.md` — suggestion sync via Docs API, limitations

**Quick reference:**
- Auth: `src/auth.ts` — NextAuth v5, `auth()` works in server components and API routes
- Drive client: `src/lib/google-drive.ts` — OAuth2Client with auto-token-refresh
- Comment sync: `src/lib/sync-comments.ts` — full-scan sync with smart unarchive
- UI entry: `src/app/docs/page.tsx` (server) → `src/components/doc-table.tsx` (client)
- Role colors: `src/lib/role-colors.ts` — Author = blue, Reviewer = violet

**Schema notes:** SQLite doesn't support enums — `Doc.role` and `Doc.status` are `String`
fields with string defaults (`"REVIEWER"`, `"ACTIVE"`). Prisma 5 is pinned (Prisma 7 dropped
`url = env(...)` support in schema.prisma).
