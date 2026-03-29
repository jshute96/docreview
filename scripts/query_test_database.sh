#!/usr/bin/env bash
#
# Run a SQL query against the docreview_test database.
#
# Same interface as query_database.sh but targets the test DB.
#
# Usage:
#   scripts/query_test_database.sh "SELECT count(*) FROM docs"
#   scripts/query_test_database.sh -x "SELECT * FROM users LIMIT 5"
#   scripts/query_test_database.sh --schema

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: .env file not found at $ENV_FILE" >&2
  exit 1
fi

# Use the readonly connection URL
RO_URL=$(grep -E '^DATABASE_URL_RO=' "$ENV_FILE" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true)

if [[ -z "$RO_URL" ]]; then
  echo "Error: DATABASE_URL_RO not found in .env" >&2
  exit 1
fi

# Replace the database name with docreview_test
DB_URL=$(echo "$RO_URL" | sed 's|/[^/]*$|/docreview_test|')

export DB_URL
export SCRIPT_NAME="scripts/query_test_database.sh"
exec "$SCRIPT_DIR/query_db_common.sh" "$@"
