# Playwright Test Suites

Automated UI and integration tests organized by what they test and what
infrastructure they need.

## Test suites

| Suite | Directory | What it tests | Infrastructure |
|-------|-----------|---------------|----------------|
| **App Offline** | `app-offline/` | Docreview UI in offline mode (no Google APIs) | Next.js on port 3010 + `docreview_test` DB |
| **App Live** | `app-live/` | Docreview with real Google OAuth and API access | Next.js on port 3010 + `docreview_test` DB + Google credentials |
| **Extension Snapshot** | `extension-snapshot/` | Content script DOM injection against saved Google page snapshots | Python HTTP server (auto-started) |
| **Extension Live** | `extension-live/` | Chrome extension interacting with running docreview | Next.js on port 3010 + `docreview_test` DB + extension loaded |

## Quick start

```bash
# Run the fast snapshot tests (no database needed)
npm run test:e2e:snapshot

# Set up the test database (one-time, or after schema changes)
testing/setup-test-db.sh

# Run offline app tests
npm run test:e2e:app-offline

# Run all suites that are ready
npm run test:e2e
```

## npm scripts

| Script | Runs |
|--------|------|
| `npm run test:e2e` | All ready suites (snapshot + app-offline) |
| `npm run test:e2e:snapshot` | Extension snapshot tests only |
| `npm run test:e2e:app-offline` | App offline tests only |
| `npm run test:e2e:extension-live` | Extension + app tests |
| `npm run test:e2e:app-live` | App with Google login tests |
| `npm run dev:test-live` | Start dev server on port 3009, online mode (Google OAuth) |
| `npm run dev:test-offline` | Start dev server on port 3009, offline mode (auto-login) |
| `npm run test:open-browser` | Open an ephemeral Playwright browser (offline mode) |
| `npm run test:open-browser-live` | Open a regular Chrome with saved profile (Google login survives across runs) |

## Running individual tests

`scripts/run-test.sh` finds the right `playwright.config.ts` automatically:

```bash
# Run a specific test file
scripts/run-test.sh testing/app-offline/labels.spec.ts

# Run a whole suite directory
scripts/run-test.sh testing/app-offline/

# Run with visible browsers (default is headless)
scripts/run-test.sh testing/app-offline/labels.spec.ts --headed
```

Or pass the config explicitly:

```bash
npx playwright test --config testing/app-offline/playwright.config.ts testing/app-offline/labels.spec.ts
```

## Interactive testing

Start the test dev server on port 3009 and browse to it:

```bash
# Online mode (Google OAuth) — use your regular browser at http://localhost:3009
npm run dev:test-live

# Offline mode (auto-login, no Google APIs)
npm run dev:test-offline

# Offline mode, impersonate a specific user (by email from test_users.json)
npm run dev:test-offline -- docreview.dave@gmail.com

# Open a Playwright browser (ephemeral — good for offline mode)
npm run test:open-browser

# Open a regular Chrome with saved profile (Google login saved across runs)
npm run test:open-browser-live
```

The dev-test server uses port 3009 and its own build directory
(`.next-test-interactive/`) so it can run concurrently with the main dev
server (3000) and Playwright test servers (3010).

## Test database

Suites that test the real app use a separate `docreview_test` PostgreSQL
database on the same server, and run Next.js on port 3010 (instead of the
default 3000). This avoids interfering with a running development instance.

```bash
testing/setup-test-db.sh          # create DB and run migrations
testing/setup-test-db.sh --reset  # drop and recreate from scratch
testing/setup-test-db.sh --status # check current state
```

The test database URL is derived automatically from `DATABASE_URL` in `.env`
by replacing the database name with `docreview_test`.

## Shared files

| File | Purpose |
|------|---------|
| `shared/test-env.ts` | Test database URL, port, and server command builder |
| `shared/test-db.ts` | Prisma client for test DB, used for DB assertions in tests |
| `setup-test-db.sh` | Create/migrate the test database |
| `test_users.json` | Test account credentials (gitignored) |
| `chrome-extension.md` | Full test case catalog (auto + manual) |
| `gmail_notifications/` | Sample Gmail notification emails for parser tests |

## Directory structure

```
testing/
  README.md                        — this file
  TODO.md                          — list of test cases needing coverage
  setup-test-db.sh                 — test database setup
  dev-test.sh                      — start dev server on port 3009 for interactive use
  open-browser-live.sh             — open regular Chrome with saved profile
  chrome-extension.md              — test case catalog
  test_users.json                  — test credentials (gitignored)
  shared/
    test-env.ts                    — shared config (DB URL, port, server command)
    test-db.ts                     — Prisma client for test DB (with base64 encoding)
  extension-snapshot/
    playwright.config.ts           — static HTTP server on port 8889
    content-script.spec.ts         — DOM injection tests
    snapshots/                     — saved HTML snapshots (gitignored)
  app-offline/
    playwright.config.ts           — Next.js on port 3010, OFFLINE_MODE=true
    smoke.spec.ts                  — login, page load, auth redirect tests
    docs.spec.ts                   — doc list and individual doc page tests
    labels.spec.ts                 — label CRUD, reorder, color, delete, cancel
    labels-crosstab.spec.ts        — cross-tab label sync across all pages/dialogs
  extension-live/
    playwright.config.ts           — Next.js + Chrome extension loaded
    (tests TBD)
  app-live/
    playwright.config.ts           — Next.js with Google OAuth
    (tests TBD)
  gmail_notifications/
    README.md                      — notification testing guide
    *.eml / *.json                 — sample emails and parsed structures
```

## Test coverage TODO

See [`TODO.md`](TODO.md) for a list of user-facing behaviors that still need
e2e test coverage. Grab items from that list when writing new tests, and add
entries when introducing user-facing changes that aren't yet covered.

## Future suites

- **`app-multiuser/`** — Two Playwright browser contexts logged in as
  different users, testing collaboration features (shared docs, comment
  notifications across users).
