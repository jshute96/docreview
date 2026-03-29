#!/usr/bin/env bash
#
# Run a readonly SQL query against the docreview database.
#
# Usage:
#   scripts/query_database.sh "SELECT count(*) FROM docs"
#   scripts/query_database.sh -f query.sql
#   echo 'SELECT 1' | scripts/query_database.sh
#
# Options:
#   -f FILE        Read SQL from a file
#   -x             Expanded display (\x on)
#   --schema       Dump schema for all tables
#   --schema TABLE Dump schema for one table
#   --help         Show this help message

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: .env file not found at $ENV_FILE" >&2
  exit 1
fi

# Use the readonly connection URL
DB_URL=$(grep -E '^DATABASE_URL_RO=' "$ENV_FILE" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true)

if [[ -z "$DB_URL" ]]; then
  echo "Error: DATABASE_URL_RO not found in .env" >&2
  exit 1
fi

export DB_URL
export SCRIPT_NAME="scripts/query_database.sh"
exec "$SCRIPT_DIR/query_db_common.sh" "$@"
