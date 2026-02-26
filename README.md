# Docreview

A personal tool for tracking Google Docs review status, comments, and suggestions via the Google Drive API.

## Prerequisites

- **Node.js 20+** (via nvm recommended)
- **PostgreSQL 14+**
- **Google Cloud project** with OAuth 2.0 credentials and Drive API enabled

## Setup

1. **nvm setup** (if not set up in .profile / .bashrc)
   ```bash
   . /home/jshute/.nvm/nvm.sh && nvm use 20
   ```

2. **Install dependencies** (each checkout needs its own node_modules):
   ```bash
   npm install
   ```

3. **Google Cloud setup:**
   - Enabled APIs & Services:
     - Enable the **Google Drive API** and **Google Docs API** in 
   - OAuth consent screen:
     - Client:
        - Create an OAuth 2.0 client (Web application type)
        - Add authorized redirect URI: `http://localhost:3000/api/auth/callback/google`
     - Data Access:
        - Add `drive` and `documents.readonly` scopes
      - Audience:
        - Set to External and add your Google account as a test user

4. **Configure `.env`:**
   ```
   DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/docreview"
   AUTH_SECRET="..."         # generate with: npx auth secret
   AUTH_GOOGLE_ID="..."
   AUTH_GOOGLE_SECRET="..."
   ```

5. **Set up postgres**
   ```bash
   sudo apt install postgresql

   sudo -u postgres psql

   # or if that doesn't work:
   sudo -i
   sudo postgres psql

   # Then in psql, as the postgres user:
   create user USER WITH PASSWORD "...";
   alter user USER CREATEDB;
   ```

6. **Create a PostgreSQL database:**
   ```bash
   createdb docreview
   ```

7. **Initialize the database:**
   ```bash
   npx prisma migrate dev
   ```

8. **Start the dev server:**
   ```bash
   npm run dev
   ```
   Visit `http://localhost:3000` and sign in with Google.

## Offline Mode

Run without Google OAuth credentials (useful for UI development, testing, or CI):

```bash
npm run dev:offline
```

In offline mode:
- **Auto-Login**: The app bypasses the login screen and automatically signs you in.
- **User Impersonation**: Pass `OFFLINE_USER_ID=<id>` to act as a specific user. If the ID doesn't exist, it will be created automatically on your first visit.
- **Session Switching**: If you restart the server with a different `OFFLINE_USER_ID`, the app detects the mismatch and re-authenticates you automatically.

All Google Drive/Docs API calls return 502 errors in this mode. Labels, doc metadata, filtering, and sorting work normally with local database data.

## Running

```bash
npm run dev
```

To run a second instance (e.g. from a separate checkout), use the `-p` flag:

```bash
npm run dev -- -p 3001
```

## Testing

```bash
npm test            # run all tests once
npm run test:watch  # run tests in watch mode
```

## After Schema Changes

If the Prisma schema (`prisma/schema.prisma`) has changed, regenerate the Prisma client and
restart the dev server:

```bash
npx prisma generate
# Then restart the dev server — Next.js won't pick up the new client until restart
```

If there are new migrations to apply:

```bash
npx prisma migrate dev
```

## Database

```bash
# Visual browser UI
npx prisma studio

# Raw SQL via psql
psql docreview

# Raw SQL via Prisma (no psql required)
echo "SELECT title, role, status FROM docs;" | npx prisma db execute --stdin
```

## Commands

```bash
npm run dev       # start dev server at http://localhost:3000
npm run build     # production build (also runs type checking)
npm run lint      # ESLint
npm run test      # run tests
npx tsc --noEmit  # type check without building

npx prisma migrate dev --name <name>  # create and apply a migration
npx prisma studio                     # open DB browser at http://localhost:5555
npx prisma generate                   # regenerate client after schema changes
```

## Architecture

- **Auth:** NextAuth v5 with Google OAuth (`src/auth.ts`)
- **Database:** PostgreSQL via Prisma 5 (`prisma/schema.prisma`)
- **Drive sync:** Google Drive API v3 (`src/lib/google-drive.ts`)
- **Comment sync:** Full-scan sync with smart unarchive (`src/lib/sync-comments.ts`)
- **UI:** Next.js App Router — server component entry (`src/app/docs/page.tsx`) with client-side table (`src/components/doc-table.tsx`)

See `docs/*.md` for detailed architecture documentation.
