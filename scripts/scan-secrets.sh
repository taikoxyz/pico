#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GITLEAKS_VERSION="${GITLEAKS_VERSION:-8.30.1}"
SCAN_MODE="${1:-tree}"
BIN_DIR="$ROOT_DIR/.cache/tools/gitleaks/$GITLEAKS_VERSION"
BIN_PATH="${PICO_GITLEAKS_BIN:-$BIN_DIR/gitleaks}"
CONFIG_PATH="$ROOT_DIR/.gitleaks.toml"

log() {
  printf 'scan-secrets: %s\n' "$*" >&2
}

platform_asset() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    *)
      log "unsupported OS: $os"
      return 1
      ;;
  esac

  case "$arch" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64) arch="x64" ;;
    *)
      log "unsupported architecture: $arch"
      return 1
      ;;
  esac

  printf 'gitleaks_%s_%s_%s.tar.gz' "$GITLEAKS_VERSION" "$os" "$arch"
}

ensure_gitleaks() {
  if [ -x "$BIN_PATH" ]; then
    return 0
  fi

  local asset url tmp_dir
  asset="$(platform_asset)"
  url="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${asset}"
  tmp_dir="$(mktemp -d)"

  trap 'rm -rf "$tmp_dir"' EXIT
  mkdir -p "$BIN_DIR"

  log "downloading gitleaks v${GITLEAKS_VERSION}"
  curl -fsSL "$url" -o "$tmp_dir/$asset"
  tar -xzf "$tmp_dir/$asset" -C "$tmp_dir"
  install -m 0755 "$tmp_dir/gitleaks" "$BIN_PATH"
  rm -rf "$tmp_dir"
  trap - EXIT
}

scan_tree() {
  (cd "$ROOT_DIR" && "$BIN_PATH" dir --config "$CONFIG_PATH" --no-banner --redact .)
}

scan_history() {
  (cd "$ROOT_DIR" && "$BIN_PATH" git --config "$CONFIG_PATH" --no-banner --redact --log-opts="--all" .)
}

scan_staged() {
  local files=()
  while IFS= read -r -d '' file; do
    files+=("$file")
  done < <(git -C "$ROOT_DIR" diff --cached --name-only --diff-filter=ACMR -z)

  if [ "${#files[@]}" -eq 0 ]; then
    log "no staged files to scan"
    return 0
  fi

  (cd "$ROOT_DIR" && "$BIN_PATH" dir --config "$CONFIG_PATH" --no-banner --redact "${files[@]}")
}

ensure_gitleaks

case "$SCAN_MODE" in
  tree|dir)
    scan_tree
    ;;
  history|git)
    scan_history
    ;;
  staged)
    scan_staged
    ;;
  *)
    log "unknown mode: $SCAN_MODE"
    log "usage: bash scripts/scan-secrets.sh [tree|history|staged]"
    exit 2
    ;;
esac
