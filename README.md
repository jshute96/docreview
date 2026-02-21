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

---

## Setup

```bash
# Install dependencies
. /home/jshute/.nvm/nvm.sh && nvm use 20
npm install

# Create the database
npx prisma migrate dev

# Start the dev server
npm run dev
```

Fill in `.env` with your credentials before starting (see CLAUDE.md for details). Then visit
`http://localhost:3000`, sign in with Google, and click **Refresh** to sync files from Drive.

## Database

```bash
# Visual browser UI
npx prisma studio

# Raw SQL (if sqlite3 is installed)
sqlite3 prisma/prisma/dev.db

# Raw SQL via Prisma (no sqlite3 required)
echo "SELECT title, role, status FROM Doc;" | npx prisma db execute --stdin
```
