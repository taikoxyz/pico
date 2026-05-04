#!/usr/bin/env bash
# Shared helpers for the mainnet smoke scripts. Sourced, not invoked.

set -euo pipefail

# Color helpers; respect NO_COLOR and non-tty.
__use_color() { [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; }
red()    { __use_color && printf '\033[31m%s\033[0m\n' "$*" || printf '%s\n' "$*"; }
green()  { __use_color && printf '\033[32m%s\033[0m\n' "$*" || printf '%s\n' "$*"; }
yellow() { __use_color && printf '\033[33m%s\033[0m\n' "$*" || printf '%s\n' "$*"; }
blue()   { __use_color && printf '\033[34m%s\033[0m\n' "$*" || printf '%s\n' "$*"; }

log()  { yellow "[$(date -u +%H:%M:%S)] $*" >&2; }
fail() { red   "[FAIL] $*" >&2; exit 1; }

# Prompt for [y/N] confirmation. --yes (or YES=1) bypasses.
confirm() {
  local prompt="${1:-Continue?}"
  if [[ "${YES:-0}" == "1" ]]; then return 0; fi
  read -r -p "$prompt [y/N] " ans
  [[ "${ans,,}" == "y" || "${ans,,}" == "yes" ]]
}

# pico CLI resolution: prefer pnpm workspace invocation so operators don't
# need a global install. Falls back to `pico` on PATH.
pico_bin() {
  if command -v pico >/dev/null 2>&1; then
    echo "pico"
  else
    echo "pnpm --silent -F @pico/cli exec pico"
  fi
}

# Append a JSON object to <log-dir>/<file>. Uses jq if available, else cat.
record() {
  local file="$1"
  local payload="$2"
  mkdir -p "$(dirname "$file")"
  if command -v jq >/dev/null 2>&1; then
    echo "$payload" | jq . > "$file"
  else
    echo "$payload" > "$file"
  fi
}

# Resolve / create the per-run log dir. Honors $LOG_DIR if pre-set so phases
# share a directory when run from run-all.sh.
resolve_log_dir() {
  if [[ -n "${LOG_DIR:-}" ]]; then
    mkdir -p "$LOG_DIR"
    echo "$LOG_DIR"
    return
  fi
  local dir="scripts/mainnet-smoke/log/$(date -u +%Y%m%d-%H%M%S)"
  mkdir -p "$dir"
  echo "$dir"
}
