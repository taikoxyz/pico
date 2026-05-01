#!/usr/bin/env bash
#
# Restore-from-litestream drill. Restores the chosen service's SQLite DB to
# a target volume, runs schema/row sanity checks, and emits a green/red
# summary line. Exit code is the gate — non-zero is a real failure.
#
# Usage:
#   infra/scripts/restore-drill.sh --service hub|watchtower --target-volume <path> \
#       [--config infra/litestream/<service>.yml] \
#       [--bucket-override s3://<staging-bucket>]

set -euo pipefail

SERVICE=""
TARGET_VOLUME=""
CONFIG=""
BUCKET_OVERRIDE=""

red()   { [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && printf '\033[31m%s\033[0m\n' "$*" || printf '%s\n' "$*"; }
green() { [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && printf '\033[32m%s\033[0m\n' "$*" || printf '%s\n' "$*"; }

usage() {
  sed -n '/^# Usage/,/^$/p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service) SERVICE="$2"; shift 2 ;;
    --target-volume) TARGET_VOLUME="$2"; shift 2 ;;
    --config) CONFIG="$2"; shift 2 ;;
    --bucket-override) BUCKET_OVERRIDE="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done

[[ "$SERVICE" == "hub" || "$SERVICE" == "watchtower" ]] || { echo "--service must be hub or watchtower" >&2; usage; }
[[ -n "$TARGET_VOLUME" ]] || { echo "--target-volume required" >&2; usage; }

[[ -n "$CONFIG" ]] || CONFIG="infra/litestream/${SERVICE}.yml"

DB_NAME="${SERVICE}.sqlite"
DB_PATH="/data/${DB_NAME}"
RESTORED="${TARGET_VOLUME}/${DB_NAME}"

if ! command -v litestream >/dev/null 2>&1; then
  red "FAIL service=${SERVICE} reason=missing-binary:litestream"
  exit 1
fi
if ! command -v sqlite3 >/dev/null 2>&1; then
  red "FAIL service=${SERVICE} reason=missing-binary:sqlite3"
  exit 1
fi

mkdir -p "$TARGET_VOLUME"
rm -f "$RESTORED" "${RESTORED}-wal" "${RESTORED}-shm"

EFFECTIVE_CONFIG="$CONFIG"
TMP_CFG=""
cleanup() { [[ -n "$TMP_CFG" ]] && rm -f "$TMP_CFG"; }
trap cleanup EXIT

if [[ -n "$BUCKET_OVERRIDE" ]]; then
  TMP_CFG=$(mktemp)
  bucket_var="LITESTREAM_BUCKET_$(echo "$SERVICE" | tr '[:lower:]' '[:upper:]')"
  bucket_no_scheme="${BUCKET_OVERRIDE#s3://}"
  sed "s|\${${bucket_var}}|${bucket_no_scheme}|g" "$CONFIG" > "$TMP_CFG"
  EFFECTIVE_CONFIG="$TMP_CFG"
fi

if ! litestream restore -o "$RESTORED" -config "$EFFECTIVE_CONFIG" "$DB_PATH" >/dev/null 2>&1; then
  red "FAIL service=${SERVICE} reason=litestream-restore-failed"
  exit 1
fi

if [[ ! -s "$RESTORED" ]]; then
  red "FAIL service=${SERVICE} reason=empty-restore"
  exit 1
fi

case "$SERVICE" in
  hub)        TABLES=(channels signed_states payment_routes htlcs payments) ;;
  watchtower) TABLES=(signed_states watchtower_observations in_flight_txs) ;;
esac

SHA1=$(sha256sum "$RESTORED" | awk '{print $1}')

ROWS=()
for t in "${TABLES[@]}"; do
  if ! count=$(sqlite3 "$RESTORED" "SELECT count(*) FROM ${t};" 2>/dev/null); then
    red "FAIL service=${SERVICE} reason=missing-table:${t}"
    exit 1
  fi
  ROWS+=("${t}:${count}")
done

SHA2=$(sha256sum "$RESTORED" | awk '{print $1}')
if [[ "$SHA1" != "$SHA2" ]]; then
  red "FAIL service=${SERVICE} reason=sha-drifted-on-read"
  exit 1
fi

SHORT_SHA=${SHA1:0:12}
green "OK service=${SERVICE} rows=$(IFS=' '; echo "${ROWS[*]}") sha=${SHORT_SHA}"
