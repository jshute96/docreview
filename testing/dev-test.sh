#!/usr/bin/env bash
#
# Start the docreview dev server against the test database for interactive use.
# Runs on port 3009 so it doesn't conflict with the main dev server (3000) or
# Playwright test servers (3010). Uses .next-test-interactive/ as its build
# directory to avoid lock conflicts with other Next.js instances.
#
# Usage:
#   testing/dev-test.sh                       # online mode (Google OAuth)
#   testing/dev-test.sh --offline             # offline mode (default user)
#   testing/dev-test.sh --offline USER_EMAIL  # offline, impersonate by email

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PORT=3009
OFFLINE=false

# Parse flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    --offline) OFFLINE=true; shift ;;
    --) shift; break ;;
    -*) echo "Unknown flag: $1" >&2; echo "Usage: testing/dev-test.sh [--offline] [user_id]" >&2; exit 1 ;;
    *) break ;;
  esac
done

# Read DATABASE_URL from .env and derive test URL
ENV_FILE="$PROJECT_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: .env not found at $ENV_FILE" >&2
  exit 1
fi
PROD_DATABASE_URL=$(grep '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2-)
TEST_DATABASE_URL=$(echo "$PROD_DATABASE_URL" | sed 's|/[^/]*$|/docreview_test|')

# Resolve user ID from email address in test_users.json.
TEST_USERS_FILE="$SCRIPT_DIR/test_users.json"

resolve_user_id() {
  local email="$1"
  if [[ ! -f "$TEST_USERS_FILE" ]]; then
    echo "Error: test_users.json not found at $TEST_USERS_FILE" >&2
    exit 1
  fi
  local match
  match=$(node -e "
    const users = require('$TEST_USERS_FILE');
    const u = users.find(u => u.user === '$email');
    if (!u) { process.stderr.write('Error: no user found for \"$email\" in test_users.json\n'); process.stderr.write('Available users: ' + users.map(u => u.user).join(', ') + '\n'); process.exit(1); }
    if (!u.user_id) { process.stderr.write('Error: user \"$email\" has no user_id in test_users.json\n'); process.exit(1); }
    console.log(u.user_id);
  ")
  echo "$match"
}

USER_ID_ENV=""
if [[ -n "${1:-}" ]]; then
  if [[ "$OFFLINE" != "true" ]]; then
    echo "Error: user impersonation requires --offline mode" >&2
    exit 1
  fi
  USER_ID=$(resolve_user_id "$1") || exit 1
  if [[ -z "$USER_ID" ]]; then exit 1; fi
  USER_ID_ENV="OFFLINE_USER_ID=$USER_ID"
  echo "Impersonating user: $1 ($USER_ID)"
fi

MODE="online"
OFFLINE_ENV=""
if [[ "$OFFLINE" == "true" ]]; then
  MODE="offline"
  OFFLINE_ENV="OFFLINE_MODE=true"
fi

echo "Starting docreview on http://localhost:$PORT (test DB, $MODE mode)"
echo "DATABASE_URL=$TEST_DATABASE_URL"
echo ""

cd "$PROJECT_DIR"
exec env \
  DATABASE_URL="$TEST_DATABASE_URL" \
  PORT="$PORT" \
  AUTH_TRUST_HOST=true \
  NEXT_DIST_DIR=.next-test-interactive \
  ${OFFLINE_ENV:+"$OFFLINE_ENV"} \
  ${USER_ID_ENV:+"$USER_ID_ENV"} \
  npx next dev --port "$PORT"
