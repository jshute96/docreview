#!/usr/bin/env bash
#
# Run Playwright e2e tests, automatically finding the right config file.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/run-test.sh <test-file-or-dir>... [playwright args...]

Run Playwright e2e tests. Finds the nearest playwright.config.ts
automatically. All test files must share the same config.

Examples:
  scripts/run-test.sh testing/app-offline/labels.spec.ts                          # one test file
  scripts/run-test.sh testing/app-offline/labels.spec.ts labels-crosstab.spec.ts  # two files
  scripts/run-test.sh testing/app-offline/                                        # all tests in a suite
  scripts/run-test.sh testing/app-offline/labels.spec.ts --headed                 # with visible browser
  scripts/run-test.sh testing/app-offline/ --grep="cross-tab"                     # filter by test name

Playwright flags with values must use = syntax (e.g., --grep="pattern").
EOF
}

if [[ $# -eq 0 || "$1" == "--help" || "$1" == "-h" ]]; then
  usage
  exit 0
fi

# Split args into test targets (files/dirs) and playwright flags
TARGETS=()
PW_ARGS=()
for arg in "$@"; do
  if [[ "$arg" == -* ]]; then
    PW_ARGS+=("$arg")
  elif [[ -f "$arg" || -d "$arg" ]]; then
    TARGETS+=("$arg")
  else
    echo "Error: $arg does not exist" >&2
    exit 1
  fi
done

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  echo "Error: No test files or directories specified" >&2
  exit 1
fi

# Find the playwright.config.ts: walk up from the given path
find_config() {
  local dir="$1"
  [[ -f "$dir" ]] && dir="$(dirname "$dir")"

  while true; do
    if [[ -f "$dir/playwright.config.ts" ]]; then
      echo "$dir/playwright.config.ts"
      return 0
    fi
    [[ "$dir" == "." || "$dir" == "/" ]] && break
    dir="$(dirname "$dir")"
  done
  return 1
}

# Verify all targets share the same config
CONFIG=""
for t in "${TARGETS[@]}"; do
  THIS_CONFIG=$(find_config "$t") || {
    echo "Error: No playwright.config.ts found for $t" >&2
    exit 1
  }
  if [[ -z "$CONFIG" ]]; then
    CONFIG="$THIS_CONFIG"
  elif [[ "$THIS_CONFIG" != "$CONFIG" ]]; then
    echo "Error: Test files use different configs:" >&2
    echo "  ${TARGETS[0]} → $CONFIG" >&2
    echo "  $t → $THIS_CONFIG" >&2
    echo "Run them separately." >&2
    exit 1
  fi
done

# Build the positional args: skip directories (config's testDir handles them)
FILE_ARGS=()
for t in "${TARGETS[@]}"; do
  [[ -f "$t" ]] && FILE_ARGS+=("$t")
done

exec npx playwright test --config "$CONFIG" "${FILE_ARGS[@]}" "${PW_ARGS[@]}"
