#!/usr/bin/env bash
#
# Open a regular Chrome browser with a dedicated profile against the test
# dev server. Google OAuth sessions are preserved across runs.
#
# This is NOT a Playwright-controlled browser — it's a normal Chrome
# instance, so Google won't block OAuth login.
#
# Usage:
#   testing/open-browser-live.sh              # default: http://localhost:3009
#   testing/open-browser-live.sh <url>        # custom URL

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE_DIR="$SCRIPT_DIR/../.chrome-test-profile"
URL="${1:-http://localhost:3009}"

# Find Chrome
if command -v google-chrome &>/dev/null; then
  CHROME=google-chrome
elif command -v google-chrome-stable &>/dev/null; then
  CHROME=google-chrome-stable
elif [[ -x "/usr/bin/google-chrome" ]]; then
  CHROME=/usr/bin/google-chrome
else
  echo "Error: Chrome not found" >&2
  exit 1
fi

echo "Opening Chrome at $URL"
echo "Profile: $PROFILE_DIR"
echo ""

exec "$CHROME" \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  "$URL"
