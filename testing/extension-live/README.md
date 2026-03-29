# Extension Live Tests

Tests that run docreview with the Chrome extension loaded. The extension
is loaded via `--load-extension` in the Playwright launch args.

These tests verify extension ↔ app interaction: badge links opening docreview,
comment sync from Google Docs, toolbar button behavior, etc.

## Prerequisites

1. Set up the test database: `testing/setup-test-db.sh`
2. Chrome extension source in `src/chrome-extension/`

## Run

```bash
npm run test:e2e:extension-live
```

## Status

Placeholder — no tests written yet.
