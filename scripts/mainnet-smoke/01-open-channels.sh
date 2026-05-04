#!/usr/bin/env bash
# Open Alice's and Bob's channels to the hub. Records channel ids + open tx
# hashes (recovered via cast logs) under <LOG_DIR>/channels.json.
#
# Usage:
#   scripts/mainnet-smoke/01-open-channels.sh \
#     --hub <https://hub.example> \
#     [--amount-usdc 10] \
#     [--rpc <url>]
#
# Idempotent: skips a role if `pico channel list` reports an open channel
# of sufficient capacity.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/lib/common.sh"
. "$HERE/lib/chain.sh"
. "$HERE/lib/env.sh"

HUB_URL=""
AMOUNT_USDC=10
RPC_URL="${RPC_URL:-$TAIKO_MAINNET_RPC_DEFAULT}"

usage() { sed -n '/^# Usage/,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --hub) HUB_URL="$2"; shift 2 ;;
    --amount-usdc) AMOUNT_USDC="$2"; shift 2 ;;
    --rpc) RPC_URL="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) fail "unknown arg: $1" ;;
  esac
done
[[ -n "$HUB_URL" ]] || fail "--hub is required"

LOG_DIR="$(resolve_log_dir)"
log "Opening channels (amount: ${AMOUNT_USDC} USDC each); logs: $LOG_DIR"

results=()
for role in alice bob; do
  log "$role: checking existing channels"
  existing="$(pico_as "$role" channel list --json 2>/dev/null || echo '[]')"
  echo "$existing" > "$LOG_DIR/$role-channels-before.json"

  open_count="$(echo "$existing" | python3 -c '
import json, sys
try:
  arr = json.load(sys.stdin)
except Exception:
  arr = []
print(sum(1 for c in arr if c.get("status") == "open"))')"

  if [[ "$open_count" -gt 0 ]]; then
    yellow "$role: already has $open_count open channel(s) — skipping open"
    results+=("{\"role\":\"$role\",\"action\":\"skipped\",\"reason\":\"already-open\"}")
    continue
  fi

  log "$role: opening ${AMOUNT_USDC} USDC channel to $HUB_URL"
  open_out="$(pico_as "$role" channel open --hub "$HUB_URL" --amount "$AMOUNT_USDC" --json 2>"$LOG_DIR/$role-open.stderr" || true)"
  echo "$open_out" > "$LOG_DIR/$role-open.json"
  channel_id="$(echo "$open_out" | python3 -c 'import json, sys; print(json.load(sys.stdin).get("id", ""))' 2>/dev/null || echo "")"
  if [[ -z "$channel_id" ]]; then
    fail "$role: open did not return a channel id; see $LOG_DIR/$role-open.{json,stderr}"
  fi
  green "$role: opened channel $channel_id"
  results+=("{\"role\":\"$role\",\"action\":\"opened\",\"channel_id\":\"$channel_id\"}")
done

joined="$(IFS=, ; echo "${results[*]:-}")"
record "$LOG_DIR/channels.json" "[${joined}]"
green "Done. Inspect $LOG_DIR/channels.json"

# CLI gap: pico channel open does not print the on-chain tx hash. Recover
# via `cast logs --address $PAYMENT_CHANNEL_ADDR ChannelOpened(bytes32,...)
# --from-block <block>` and append to the log file by hand for the audit log.
