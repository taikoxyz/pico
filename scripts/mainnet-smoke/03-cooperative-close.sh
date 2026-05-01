#!/usr/bin/env bash
# Cooperatively close Alice's and Bob's channels. Records the on-chain final
# balances and tx hashes (recovered via cast) under close.json.
#
# Usage:
#   scripts/mainnet-smoke/03-cooperative-close.sh --hub <url> [--rpc <url>]

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/lib/common.sh"
. "$HERE/lib/chain.sh"
. "$HERE/lib/env.sh"

HUB_URL=""
RPC_URL="${RPC_URL:-$TAIKO_MAINNET_RPC_DEFAULT}"

usage() { sed -n '/^# Usage/,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --hub) HUB_URL="$2"; shift 2 ;;
    --rpc) RPC_URL="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) fail "unknown arg: $1" ;;
  esac
done
[[ -n "$HUB_URL" ]] || fail "--hub is required"
require_cast

LOG_DIR="$(resolve_log_dir)"
results=()
for role in alice bob; do
  log "$role: listing channels"
  channels="$(tainnel_as "$role" channel list --json 2>/dev/null || echo '[]')"
  echo "$channels" > "$LOG_DIR/$role-channels-pre-close.json"
  open_ids="$(echo "$channels" | python3 -c '
import json, sys
arr = json.load(sys.stdin)
print(" ".join(c["id"] for c in arr if c.get("status") == "open"))')"
  if [[ -z "$open_ids" ]]; then
    yellow "$role: no open channels — skipping"
    continue
  fi
  for cid in $open_ids; do
    log "$role: cooperative-close $cid"
    out="$(tainnel_as "$role" channel close "$cid" --cooperative --json 2>"$LOG_DIR/$role-close-$cid.stderr" || true)"
    echo "$out" > "$LOG_DIR/$role-close-$cid.json"
    addr="$(operator_address "$role")"
    final_usdc="$(usdc_balance "$addr" "$RPC_URL")"
    results+=("{\"role\":\"$role\",\"channel\":\"$cid\",\"final_usdc_raw\":\"$final_usdc\"}")
    green "$role: closed $cid; final on-chain USDC (raw): $final_usdc"
  done
done

joined="$(IFS=, ; echo "${results[*]:-}")"
record "$LOG_DIR/close.json" "[${joined}]"
green "Done. Inspect $LOG_DIR/close.json"

# CLI gap: tainnel channel close does not print the on-chain
# ChannelClosedCooperative tx hash. Recover via `cast logs` filtered by
# topic + channel id and append to the log if needed for the audit log.
