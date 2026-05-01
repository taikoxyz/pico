#!/usr/bin/env bash
# Stale-state penalty drill on Carol's dedicated channel.
#
# Carol opens a channel, exchanges at least one signed state with the hub,
# then submits closeUnilateral with the OLDER state. The watchtower must
# observe + submit the newer state within `--watchtower-deadline` seconds.
#
# Usage:
#   scripts/mainnet-smoke/04-dispute-drill.sh \
#     --hub <https://hub.example> \
#     [--amount-usdc 10] \
#     [--watchtower-deadline 300] \
#     [--rpc <url>]
#
# CLI gap: `tainnel channel close --unilateral` closes with the *latest*
# state. There is no CLI command to close with an *older* state. The drill
# therefore drops to `cast send closeUnilateral(bytes32,bytes,bytes)`
# with the encoded older state pulled from Carol's local sqlite DB and
# re-encoded via a tiny inline node snippet that imports @tainnel/sdk's
# encodeChannelStateForOnChain + signatureToHex. The encoding step is
# left as a documented operator step rather than executed inline because
# it touches operator passphrases.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/lib/common.sh"
. "$HERE/lib/chain.sh"
. "$HERE/lib/env.sh"

HUB_URL=""
AMOUNT_USDC=10
WATCHTOWER_DEADLINE=300
RPC_URL="${RPC_URL:-$TAIKO_MAINNET_RPC_DEFAULT}"

usage() { sed -n '/^# Usage/,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --hub) HUB_URL="$2"; shift 2 ;;
    --amount-usdc) AMOUNT_USDC="$2"; shift 2 ;;
    --watchtower-deadline) WATCHTOWER_DEADLINE="$2"; shift 2 ;;
    --rpc) RPC_URL="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) fail "unknown arg: $1" ;;
  esac
done
[[ -n "$HUB_URL" ]] || fail "--hub is required"
require_cast

LOG_DIR="$(resolve_log_dir)"
log "Dispute drill (Carol); deadline ${WATCHTOWER_DEADLINE}s; logs: $LOG_DIR"

# 1. Open Carol's drill channel.
log "Carol: opening drill channel (${AMOUNT_USDC} USDC)"
open_json="$(tainnel_as carol channel open --hub "$HUB_URL" --amount "$AMOUNT_USDC" --json 2>"$LOG_DIR/carol-open.stderr")"
echo "$open_json" > "$LOG_DIR/carol-open.json"
CHANNEL_ID="$(echo "$open_json" | python3 -c 'import json, sys; print(json.load(sys.stdin).get("id", ""))')"
[[ -n "$CHANNEL_ID" ]] || fail "Carol: open did not return a channel id"
green "Carol: opened $CHANNEL_ID"

# 2. Exchange a signed state by paying a tiny amount via the hub. This
#    yields v1 (open) and v2 (post-pay) — v1 becomes the stale state.
log "Carol: keysend 0.5 USDC to hub to advance state to v2"
tainnel_as carol pay --to "$(echo "$open_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["counterparty"])')" --amount 0.5 --via "$HUB_URL" --json \
  >"$LOG_DIR/carol-keysend.json" 2>"$LOG_DIR/carol-keysend.stderr" || true

cat <<EOF
${YELLOW:-}>>> Operator action required <<<
The next step posts the OLDER (stale) state via cast send. The CLI cannot
do this; you must pull the v1 signed state from Carol's sqlite DB at
"$(operator_dir carol)/db/" and submit closeUnilateral with it.

Suggested inline encoding (run from repo root):
  node --input-type=module -e "
    import { encodeChannelStateForOnChain, signatureToHex } from '@tainnel/sdk';
    const state = { /* v1 fields from db */ };
    const sig = '0x...';  /* Alice's sigA on v1 from db */
    console.log(JSON.stringify({
      data: encodeChannelStateForOnChain(state),
      sig: signatureToHex(sig),
    }));
  "

Then submit:
  cast send $PAYMENT_CHANNEL_ADDR \\
    'closeUnilateral(bytes32,bytes,bytes)' \\
    $CHANNEL_ID <encoded-state> <sig> \\
    --rpc-url "$RPC_URL" --private-key <carol-pk-stdin>

Press Enter once you have submitted the stale-state closeUnilateral...
EOF
read -r _

# 3. Poll for watchtower's penalty submission.
log "Polling for watchtower penalty (deadline ${WATCHTOWER_DEADLINE}s)..."
deadline=$(( $(date +%s) + WATCHTOWER_DEADLINE ))
posted=""
penalized=""
while (( $(date +%s) < deadline )); do
  row="$(cast call "$PAYMENT_CHANNEL_ADDR" \
    'channels(bytes32)(address,address,address,uint128,uint128,uint128,uint8,uint64,uint64,address,bool)' \
    "$CHANNEL_ID" --rpc-url "$RPC_URL" 2>/dev/null || true)"
  posted="$(echo "$row" | sed -n '8p' | tr -d ' ')"
  penalized="$(echo "$row" | sed -n '11p' | tr -d ' ')"
  log "  posted=$posted penalized=$penalized"
  if [[ "$posted" -ge 2 && "$penalized" == "true" ]]; then
    green "Watchtower won — postedVersion=$posted penalized=true"
    record "$LOG_DIR/dispute.json" "{\"channel\":\"$CHANNEL_ID\",\"posted\":$posted,\"penalized\":true,\"status\":\"ok\"}"
    exit 0
  fi
  sleep 10
done

red "ABORT: watchtower did not penalize within ${WATCHTOWER_DEADLINE}s. Apply D10.5."
record "$LOG_DIR/dispute.json" "{\"channel\":\"$CHANNEL_ID\",\"posted\":$posted,\"penalized\":$penalized,\"status\":\"abort\"}"
exit 1
