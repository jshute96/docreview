# App Live Tests

Tests that run docreview with real Google OAuth login and API access.
These tests verify features that require a live Google session: Drive sync,
comment fetching, doc list with real data, etc.

## Prerequisites

1. Set up the test database: `testing/setup-test-db.sh`
2. Valid Google OAuth credentials in `.env`
3. A valid session for a test user in the test database (see Bootstrap below)

## Bootstrap

Tests authenticate by reading a session token from the test database — no
interactive Google OAuth is needed during test runs. But a valid session must
exist in the database first.

If you've never logged in (or the session has expired), log in manually:

```bash
testing/dev-test.sh                    # start test server on port 3009
testing/open-browser-live.sh           # open Chrome, log in as the test user
```

Then verify it works by running the login test:

```bash
scripts/run-test.sh testing/app-live/login.spec.ts
```

The setup project (`auth.setup.ts`) finds the session in the test database,
sets the cookie, and saves auth state to `.auth/user.json`. Subsequent test
runs reuse the saved state until the session expires.

## Run

```bash
scripts/run-test.sh testing/app-live/login.spec.ts    # login bootstrap + basic check
scripts/run-test.sh testing/app-live/                 # all app-live tests
scripts/run-test.sh testing/app-live/ --headed        # visible browser
```
