#!/usr/bin/env bash
# Operator environment resolution. Sourced.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

OPERATOR_HOME_BASE="${OPERATOR_HOME_BASE:-$HOME/.pico}"
ROLES=(alice bob carol)

operator_dir() {
  local role="$1"
  echo "$OPERATOR_HOME_BASE/$role"
}

operator_key_file() {
  local role="$1"
  echo "$(operator_dir "$role")/key.enc"
}

# Run a pico CLI invocation under a specific operator role.
pico_as() {
  local role="$1"; shift
  PICO_CONFIG_DIR="$(operator_dir "$role")" $(pico_bin) "$@"
}

# Fetch the printed address for a role from `pico keys show`.
operator_address() {
  local role="$1"
  PICO_CONFIG_DIR="$(operator_dir "$role")" $(pico_bin) keys show 2>/dev/null \
    | awk -F': ' '/^address:/ { print $2; exit }'
}
