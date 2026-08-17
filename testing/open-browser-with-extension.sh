#!/usr/bin/env bash
#
# Open a browser with the Docreview extension loaded against the test dev server.
# Uses Playwright's bundled Chromium (system Chrome removed --load-extension support).
#
# Usage:
#   testing/open-browser-with-extension.sh              # default: http://localhost:3009
#   testing/open-browser-with-extension.sh <url>        # custom URL
#
# Start the test dev server first:
#   testing/dev-test.sh --offline
#
# Prerequisites:
#   pnpm exec playwright install chromium

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROFILE_DIR="$PROJECT_DIR/.chrome-test-extension-profile"
EXTENSION_DIR="$PROJECT_DIR/src/chrome-extension"
URL="${1:-http://localhost:3009}"

# Find Playwright's bundled Chromium (Linux path; macOS would be different)
CHROME=$(find ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome 2>/dev/null | sort -V | tail -1)
if [[ -z "$CHROME" ]]; then
  echo "Error: Playwright's bundled Chromium not found." >&2
  echo "Install it with: pnpm exec playwright install chromium" >&2
  exit 1
fi

echo "Opening Chromium at $URL"
echo "Binary: $CHROME"
echo "Profile: $PROFILE_DIR"
echo "Extension: $EXTENSION_DIR"
echo ""

exec "$CHROME" \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --disable-extensions-except="$EXTENSION_DIR" \
  --load-extension="$EXTENSION_DIR" \
  "$URL"
