#!/usr/bin/env bash
# Operator environment resolution. Sourced.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

OPERATOR_HOME_BASE="${OPERATOR_HOME_BASE:-$HOME/.tainnel}"
ROLES=(alice bob carol)

operator_dir() {
  local role="$1"
  echo "$OPERATOR_HOME_BASE/$role"
}

operator_key_file() {
  local role="$1"
  echo "$(operator_dir "$role")/key.enc"
}

# Run a tainnel CLI invocation under a specific operator role.
tainnel_as() {
  local role="$1"; shift
  TAINNEL_CONFIG_DIR="$(operator_dir "$role")" $(tainnel_bin) "$@"
}

# Fetch the printed address for a role from `tainnel keys show`.
operator_address() {
  local role="$1"
  TAINNEL_CONFIG_DIR="$(operator_dir "$role")" $(tainnel_bin) keys show 2>/dev/null \
    | awk -F': ' '/^address:/ { print $2; exit }'
}
