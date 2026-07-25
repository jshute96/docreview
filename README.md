# Docreview

Docreview makes reviewing Google Docs, Sheets, and Slides, and tracking your comment threads, manageable.

Docreview connects to Google Drive to find your documents, and to Gmail to get notifications on comment threads.

The main page is an Inbox view showing all documents with updated comment threads.

Click a document to open its details page.
The details page shows your active comment threads (all threads on your docs, and threads you've commented on in other docs).
You can read, reply, or resolve comments from that page, or click Open to jump to the thread in Google Docs.

Both pages support labeling, starring, and filtering the view by status.
Docs or comments can be Archived to hide them from Inbox views.
By default, docs re-enter your Inbox when there's new activity on your comment threads.

There's an optional Chrome extension that pairs with Docreview, improving the interaction with the Google apps, with live updates and smoother navigation between Docreview and Docs windows.
The extension also provides more complete status for comments and suggestions than the Docs or Drive APIs expose.

## Status

This is a personal tool primarily for my own use so far.
There is no hosted instance currently.
You can run your own instances, but setup is a bit complicated.

## Permissions and privacy

Docreview asks for three Google scopes:

| Scope | Why |
|-------|-----|
| `drive` | Full Drive access. Read access alone isn't enough — replying to a comment and resolving a thread are writes, and there is no narrower Drive scope that permits them |
| `documents.readonly` | Reads suggestions and document text, which the Drive API doesn't expose |
| `gmail.readonly` | Reads Docs notification emails to catch comment activity. Nothing else in your mail is touched, and nothing is ever sent |

`drive` and `gmail.readonly` are classed as sensitive/restricted by Google. A self-hosted
instance that hasn't gone through Google's verification review shows an "unverified app"
warning at sign-in and is limited to the test users you list on the OAuth consent screen
(100 max). For personal use that's fine — add your own account as a test user and continue
past the warning.

**Where your data goes:** nowhere but your own machine. Docreview runs against your own
PostgreSQL database and talks only to Google's APIs — there is no hosted instance and no
third-party server involved.

What's stored locally is metadata, not content (other than notes text you add). The `comments` table holds IDs, timestamps,
counts, and flags (read, starred, resolved, mentioned) — no comment text, no author names.
Document titles aren't stored either; they're cached in your browser's localStorage. Comment
and document text is fetched from Google on page load and kept in memory only.

**Restricting who can sign in:** set `ALLOWED_EMAILS` to a comma-separated list of addresses
to reject sign-ins from anyone else. With it unset, anyone who can reach the server and pass
Google OAuth gets an account — worth setting if you deploy anywhere public.

## Prerequisites

- **Node.js 20+** (via nvm recommended)
- **PostgreSQL 14+**
- **Google Cloud project** with OAuth 2.0 credentials and the Drive, Docs, and Gmail APIs enabled

## Setup

1. **nvm setup** (if not set up in .profile / .bashrc)
   ```bash
   . $HOME/.nvm/nvm.sh && nvm use 20
   ```

2. **Install dependencies** (each checkout needs its own node_modules):
   ```bash
   npm install
   ```

3. **Google Cloud setup:**
   - Enabled APIs & Services:
     - Enable the **Google Drive API**, **Google Docs API**, and **Gmail API**
       (Gmail is used only to pick up comment notification emails)
   - OAuth consent screen:
     - Client:
        - Create an OAuth 2.0 client (Web application type)
        - Add authorized redirect URI: `http://localhost:3000/api/auth/callback/google`
     - Data Access:
        - Add `drive`, `documents.readonly`, and `gmail.readonly` scopes
          (see [Permissions and privacy](#permissions-and-privacy) for why each is needed)
      - Audience:
        - Set to External and add your Google account as a test user.
        - Leave as Internal for corp account.

4. **Configure `.env`:** copy `.env.example` to `.env` and fill in at least these fields:
   ```bash
   cp .env.example .env
   ```
   ```
   DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/docreview"
   AUTH_SECRET="..."         # generate with: npx auth secret
   AUTH_GOOGLE_ID="..."
   AUTH_GOOGLE_SECRET="..."
   ```

5. **Proxy & HTTPS Setup:**
   This is not necessary to access a server directly using http://localhost:3000.

   If you are accessing the server via a reverse proxy (e.g., Nginx, Caddy, or a cloud dev proxy), add these to `.env`:
   ```
   AUTH_URL="https://myapp.example.com"
   AUTH_TRUST_HOST=true
   ```
   Ensure you add the `https` callback URL to your OAuth provider's authorized redirect URIs (e.g., in the Google Cloud Console):
   `https://myapp.example.com/api/auth/callback/google`

6. **Set up postgres**
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

7. **Create a PostgreSQL database:**
   ```bash
   createdb docreview
   ```

8. **Initialize the database:**
   ```bash
   npx prisma migrate dev
   ```

9. **Start the dev server:**
   ```bash
   npm run dev
   ```
   Visit `http://localhost:3000` and sign in with Google.

## Chrome Extension

The optional extension lives in this repo at `src/chrome-extension/`. It isn't published to
the Chrome Web Store — load it unpacked:

1. Open `chrome://extensions` and enable **Developer mode** (top right)
2. Click **Load unpacked** and select the `src/chrome-extension/` directory
3. Right-click the Docreview toolbar icon → **Options** to set your server URL
   (defaults to `http://localhost:3000`)

Docreview works without the extension, but works better with it.
See `src/chrome-extension/README.md` for what it adds and
how to configure it, and `docs/chrome-extension.md` for the design.

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

## Log files

Log files are written to `logs/docreview-YYYY-MM-DD.log`.

## Page URLs

| Path | Description |
|------|-------------|
| `/docs` | Main document list — filters, sorting, bulk edit, refresh |
| `/comments/[id]` | Document detail — comment threads, reply, resolve |
| `/add` | Standalone add-document form — also accessible via the "Add doc" button on the doc list |
| `/add?doc=...` | Pre-fills the URL field and auto-validates — useful for browser extensions. Accepts an optional `notes=...` param to pre-fill the notes field |
| `/open?doc=...` | Opens a Google Doc URL in Docreview: redirects to the doc's detail page if it's already tracked, otherwise to `/add`. Follows URL shorteners. This is the entry point the Chrome extension uses |

## Testing

```bash
npm test            # run all unit tests once
npm run test:watch  # run unit tests in watch mode
npm run typecheck   # type check without building
```

A pre-commit hook (via Husky) runs `npm test` and `npm run typecheck` automatically before each commit.

### UI tests (Playwright)

UI tests live in `testing/` and run against a separate `docreview_test` database.
They are not part of the pre-commit hook since they require database setup and
are slower to run.

```bash
testing/setup-test-db.sh                                # one-time DB setup
npm run test:e2e                                        # run all UI test suites
scripts/run-test.sh testing/app-offline/labels.spec.ts  # run a specific test file
scripts/run-test.sh testing/app-offline/ --headed       # run a suite with visible browsers
```

See `testing/README.md` for full details on test suites, interactive testing,
and database setup.

## Troubleshooting

### "Compiling..." hangs in dev server

Next.js compiles routes on-demand in dev mode. If the dev server gets stuck on
"Compiling /api/..." and never finishes, the `.next` cache is likely stale or
corrupted. Fix by clearing it and restarting:

```bash
# Stop the dev server (Ctrl+C), then:
rm -rf .next
npm run dev
```

The first request after a cold start may take several seconds to compile routes
with deep dependency chains (e.g., `/api/docs/[docId]/refresh`). Subsequent
requests will be fast.

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

### Readonly database user

A readonly PostgreSQL user (`docreview_ro`) is available for safe ad-hoc queries.
The `scripts/query_database.sh` script uses this user automatically.

**One-time setup** (only needed once per PostgreSQL installation):

```bash
sudo -u postgres psql -c "
CREATE USER docreview_ro WITH PASSWORD '<password>';
GRANT CONNECT ON DATABASE docreview TO docreview_ro;
GRANT USAGE ON SCHEMA public TO docreview_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO docreview_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO docreview_ro;
"
```

Then add the connection string to `.env`:
```
DATABASE_URL_RO=postgresql://docreview_ro:<password>@localhost:5432/docreview
```

**Usage:**

```bash
scripts/query_database.sh "SELECT count(*) FROM docs"
scripts/query_database.sh -x "SELECT * FROM docs LIMIT 3"    # expanded display
scripts/query_database.sh -f query.sql                       # from file
scripts/query_database.sh --schema                           # dump all table schemas
scripts/query_database.sh --schema docs                      # dump schema for one table
scripts/query_database.sh --help                             # full usage
```

## Commands

```bash
npm run dev       # start dev server at http://localhost:3000
npm run build     # production build (also runs type checking)
npm run lint      # ESLint
npm run test      # run tests
npm run typecheck # type check without building

npx prisma migrate dev --name <name>  # create and apply a migration
npx prisma studio                     # open DB browser at http://localhost:5555
npx prisma generate                   # regenerate client after schema changes
```

## Deploying to Google Cloud

See [docs/gcp-deploy.md](docs/gcp-deploy.md) for full instructions on deploying to Cloud Run + Cloud SQL.

## Architecture

- **Auth:** NextAuth.js v5 with Google OAuth. Always use `getValidSession()` or `requireAuth()` from `src/lib/auth-utils.ts` for consistency between online and offline modes.
- **Database:** PostgreSQL via Prisma 5 (`prisma/schema.prisma`).
- **Pages:** Server Components (e.g., `src/app/docs/page.tsx`) handle initial data fetching.
- **UI Components:** Client-side React state for interactive filtering and sorting (e.g., `src/components/doc-table.tsx`).
- **API Layer:** Next.js API routes (`src/app/api/...`) handle actions like syncing and label updates.
- **Sync Engine:** `src/lib/sync-comments.ts` coordinates fetching comments and suggestions from Google APIs and syncing them with the local database.

See `docs/*.md` for detailed documentation.

## Tech Stack

- **Framework:** Next.js 16 (App Router) with React 19
- **Styling:** Tailwind CSS 4 with Shadcn/UI primitives
- **Database:** PostgreSQL managed via Prisma 5
- **Authentication:** NextAuth.js v5 with Google OAuth
- **APIs:** Google Drive API v3, Google Docs API v1, and Gmail API v1

## License

MIT — see [LICENSE](LICENSE).
