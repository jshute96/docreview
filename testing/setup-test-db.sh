#!/usr/bin/env bash
#
# Set up the docreview_test database for Playwright UI tests.
#
# Creates the database if it doesn't exist and runs Prisma migrations.
# Users are created automatically on first login (offline or Google OAuth).
#
# Usage:
#   testing/setup-test-db.sh          # create and migrate
#   testing/setup-test-db.sh --reset  # drop and recreate from scratch
#   testing/setup-test-db.sh --status # check if DB exists and is migrated

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Derive test DATABASE_URL from production one (replace DB name)
source_env() {
  local env_file="$PROJECT_DIR/.env"
  if [[ ! -f "$env_file" ]]; then
    echo "Error: .env file not found at $env_file" >&2
    exit 1
  fi
  # Read DATABASE_URL from .env
  PROD_DATABASE_URL=$(grep '^DATABASE_URL=' "$env_file" | head -1 | cut -d= -f2-)
  if [[ -z "$PROD_DATABASE_URL" ]]; then
    echo "Error: DATABASE_URL not found in .env" >&2
    exit 1
  fi
  # Replace the database name (last path component) with docreview_test
  TEST_DATABASE_URL=$(echo "$PROD_DATABASE_URL" | sed 's|/[^/]*$|/docreview_test|')
  export DATABASE_URL="$TEST_DATABASE_URL"

  # Build a psql connection URL pointing at the default 'postgres' DB
  # (for CREATE/DROP DATABASE commands that can't target the DB being created)
  ADMIN_URL=$(echo "$PROD_DATABASE_URL" | sed 's|/[^/]*$|/postgres|')
}

db_exists() {
  psql "$ADMIN_URL" -tAc "SELECT 1 FROM pg_database WHERE datname = 'docreview_test'" 2>/dev/null | grep -q 1
}

create_db() {
  echo "Creating database docreview_test..."
  psql "$ADMIN_URL" -c "CREATE DATABASE docreview_test" 2>/dev/null
  echo "Database created."
}

drop_db() {
  echo "Dropping database docreview_test..."
  psql "$ADMIN_URL" -c "DROP DATABASE IF EXISTS docreview_test" 2>/dev/null
  echo "Database dropped."
}

run_migrations() {
  echo "Running Prisma migrations against docreview_test..."
  cd "$PROJECT_DIR"
  pnpm exec prisma migrate deploy 2>&1
  echo "Migrations complete."
}

grant_readonly() {
  echo "Granting readonly access to docreview_ro..."
  psql "$DATABASE_URL" -c "
    GRANT CONNECT ON DATABASE docreview_test TO docreview_ro;
    GRANT USAGE ON SCHEMA public TO docreview_ro;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO docreview_ro;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO docreview_ro;
  " 2>/dev/null
  echo "Readonly access granted."
}

# --- Main ---

source_env

case "${1:-}" in
  --reset)
    drop_db
    create_db
    run_migrations
    grant_readonly
    echo "Test database reset complete."
    ;;
  --status)
    if db_exists; then
      echo "Database docreview_test exists."
      echo "DATABASE_URL=$DATABASE_URL"
      cd "$PROJECT_DIR"
      pnpm exec prisma migrate status 2>&1
    else
      echo "Database docreview_test does not exist."
      echo "Run: testing/setup-test-db.sh"
    fi
    ;;
  "")
    if db_exists; then
      echo "Database docreview_test already exists, running migrations..."
    else
      create_db
    fi
    run_migrations
    grant_readonly
    echo "Test database ready."
    ;;
  *)
    echo "Usage: testing/setup-test-db.sh [--reset|--status]" >&2
    exit 1
    ;;
esac

echo "TEST_DATABASE_URL=$DATABASE_URL"
