#!/usr/bin/env bash
# Bob runs `pico listen` in the background; Alice creates an invoice via
# Bob's CLI and pays it. Asserts the preimage receipt is printed and Bob's
# listener reports settle.
#
# Usage:
#   scripts/mainnet-smoke/02-pay.sh \
#     --hub <https://hub.example> \
#     [--amount-usdc 1]

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/lib/common.sh"
. "$HERE/lib/env.sh"

HUB_URL=""
AMOUNT_USDC=1

usage() { sed -n '/^# Usage/,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --hub) HUB_URL="$2"; shift 2 ;;
    --amount-usdc) AMOUNT_USDC="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) fail "unknown arg: $1" ;;
  esac
done
[[ -n "$HUB_URL" ]] || fail "--hub is required"

LOG_DIR="$(resolve_log_dir)"
log "Pay flow: Alice → Bob, ${AMOUNT_USDC} USDC; logs: $LOG_DIR"

# 1. Background Bob's listener.
listen_log="$LOG_DIR/bob-listen.log"
log "Bob: starting listen → $listen_log"
( pico_as bob listen --hub "$HUB_URL" --log-format json >"$listen_log" 2>&1 ) &
LISTEN_PID=$!
trap 'kill $LISTEN_PID 2>/dev/null || true' EXIT

# Give listen a moment to subscribe.
sleep 3

# 2. Bob creates an invoice.
log "Bob: creating invoice"
inv_json="$(pico_as bob invoice create --amount "$AMOUNT_USDC" --memo "mainnet-smoke" --json 2>"$LOG_DIR/bob-invoice.stderr")"
echo "$inv_json" > "$LOG_DIR/bob-invoice.json"
INVOICE="$(echo "$inv_json" | python3 -c 'import json, sys; print(json.load(sys.stdin).get("invoice", ""))')"
[[ -n "$INVOICE" ]] || fail "Bob: invoice creation did not produce an invoice string; see $LOG_DIR/bob-invoice.{json,stderr}"
green "Bob: invoice created"

# 3. Alice pays.
log "Alice: paying invoice"
pay_json="$(pico_as alice pay --invoice "$INVOICE" --via "$HUB_URL" --json 2>"$LOG_DIR/alice-pay.stderr")"
echo "$pay_json" > "$LOG_DIR/alice-pay.json"
status="$(echo "$pay_json" | python3 -c 'import json, sys; print(json.load(sys.stdin).get("status", ""))')"
if [[ "$status" != "settled" ]]; then
  fail "Alice: pay status=$status (expected settled); see $LOG_DIR/alice-pay.{json,stderr}"
fi
green "Alice: payment settled"

# 4. Confirm Bob's listener saw the settle event.
sleep 2
if grep -q '"event":"htlc:settled"' "$listen_log"; then
  green "Bob: listener observed htlc:settled"
else
  red "Bob: no htlc:settled event in listener log within 2s — inspect $listen_log"
  fail "listener did not observe settle"
fi

record "$LOG_DIR/pay.json" "{\"amount_usdc\":$AMOUNT_USDC,\"status\":\"settled\"}"
green "Done. Inspect $LOG_DIR"
