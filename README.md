# Docreview

A personal Google Workspace file tracking tool. Syncs Docs, Sheets, and Slides from Google
Drive and lets you track custom metadata: role (Author/Reviewer), status (Active/Archived),
and labels.

## Running

```bash
. /home/jshute/.nvm/nvm.sh && nvm use 20
npm run dev
```

Visit `http://localhost:3000`.

To run a second instance (e.g. from a separate checkout), use the `-p` flag:

```bash
npm run dev -- -p 3001
```

To share the database with another checkout, set the database path in `.env`:

```
DATABASE_URL="file:/home/jshute/dev/docreview/prisma/prisma/dev.db"
```

---

## Setup

```bash
# Install dependencies (each checkout needs its own node_modules)
. /home/jshute/.nvm/nvm.sh && nvm use 20
npm install

# Create the database
npx prisma migrate dev

# Start the dev server
npm run dev

# Start server on a specific port.
npm run dev -- -p 3001
```

Fill in `.env` with your credentials before starting (see CLAUDE.md for details). Then visit
`http://localhost:3000`, sign in with Google, and click **Refresh** to sync files from Drive.

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

# Raw SQL (if sqlite3 is installed)
sqlite3 prisma/prisma/dev.db

# Raw SQL via Prisma (no sqlite3 required)
echo "SELECT title, role, status FROM Doc;" | npx prisma db execute --stdin
```
