# App Live Tests

Tests that run docreview with real Google OAuth login and API access.
These tests can verify Drive sync, comment fetching, Gmail notification
parsing, and other features that require live Google APIs.

## Prerequisites

1. Set up the test database: `testing/setup-test-db.sh`
2. Valid Google OAuth credentials in `.env`
3. Auth state saved (one-time interactive login — TBD)

## Run

```bash
npm run test:e2e:app-live
```

## Status

Placeholder — no tests written yet. Auth state setup script still needed.
