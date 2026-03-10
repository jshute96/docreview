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

# Parse DATABASE_URL_RO from .env
DB_URL=$(grep -E '^DATABASE_URL_RO=' "$ENV_FILE" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true)

if [[ -z "$DB_URL" ]]; then
  echo "Error: DATABASE_URL_RO not found in .env" >&2
  exit 1
fi

EXPANDED=""
SQL_FILE=""
SQL_ARG=""
SCHEMA=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help)
      echo "Run a readonly SQL query against the docreview database."
      echo ""
      echo "Usage:"
      echo "  scripts/query_database.sh \"SELECT count(*) FROM docs\""
      echo "  scripts/query_database.sh -f query.sql"
      echo "  echo 'SELECT 1' | scripts/query_database.sh"
      echo ""
      echo "Options:"
      echo "  -f FILE        Read SQL from a file"
      echo "  -x             Expanded display (\\x on)"
      echo "  --schema       Dump schema for all tables"
      echo "  --schema TABLE Dump schema for one table"
      echo "  --help         Show this help message"
      echo ""
      echo "Tables: docs, comments, users, accounts, labels, doc_labels,"
      echo "  sessions, statuses, verification_tokens, _prisma_migrations"
      exit 0
      ;;
    -x)
      EXPANDED="-x"
      shift
      ;;
    --schema)
      SCHEMA=true
      if [[ $# -gt 1 && ! "$2" =~ ^- ]]; then
        SCHEMA_TABLE="$2"
        shift
      fi
      shift
      ;;
    -f)
      SQL_FILE="$2"
      shift 2
      ;;
    -*)
      echo "Unknown flag: $1" >&2
      exit 1
      ;;
    *)
      if [[ -n "$SQL_ARG" ]]; then
        echo "Error: unexpected argument: $1" >&2
        exit 1
      fi
      SQL_ARG="$1"
      shift
      ;;
  esac
done

PSQL_OPTS=(--no-psqlrc --set=ON_ERROR_STOP=1 $EXPANDED)

if [[ "$SCHEMA" == true ]]; then
  TABLE_FILTER=""
  if [[ -n "${SCHEMA_TABLE:-}" ]]; then
    TABLE_FILTER="AND t.table_name = '$SCHEMA_TABLE'"
  fi
  SCHEMA_SQL="
SELECT
  t.table_name,
  c.column_name,
  c.data_type,
  c.character_maximum_length,
  c.is_nullable,
  c.column_default
FROM information_schema.tables t
JOIN information_schema.columns c ON c.table_name = t.table_name AND c.table_schema = t.table_schema
WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE' $TABLE_FILTER
ORDER BY t.table_name, c.ordinal_position;
"
  psql "$DB_URL" "${PSQL_OPTS[@]}" -c "$SCHEMA_SQL"
  exit 0
fi

if [[ -n "$SQL_FILE" ]]; then
  psql "$DB_URL" "${PSQL_OPTS[@]}" -f "$SQL_FILE"
elif [[ -n "$SQL_ARG" ]]; then
  psql "$DB_URL" "${PSQL_OPTS[@]}" -c "$SQL_ARG"
elif [[ ! -t 0 ]]; then
  psql "$DB_URL" "${PSQL_OPTS[@]}"
else
  echo "Error: No SQL provided. Pass a query string, -f file, or pipe stdin." >&2
  echo "Run with --help for usage." >&2
  exit 1
fi
