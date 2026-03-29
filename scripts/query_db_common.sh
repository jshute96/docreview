#!/usr/bin/env bash
#
# Common implementation for database query scripts.
# Not meant to be called directly — use query_database.sh or query_test_database.sh.
#
# Expects DB_URL to be set by the calling script.

set -euo pipefail

if [[ -z "${DB_URL:-}" ]]; then
  echo "Error: DB_URL not set. This script should be called via a wrapper." >&2
  exit 1
fi

EXPANDED=""
SQL_FILE=""
SQL_ARG=""
SCHEMA=false
SCRIPT_NAME="${SCRIPT_NAME:-scripts/query_database.sh}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help)
      echo "Run a SQL query against the database."
      echo ""
      echo "Usage:"
      echo "  $SCRIPT_NAME \"SELECT count(*) FROM docs\""
      echo "  $SCRIPT_NAME -f query.sql"
      echo "  echo 'SELECT 1' | $SCRIPT_NAME"
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
