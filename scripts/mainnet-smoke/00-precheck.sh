#!/usr/bin/env bash
# Pre-flight checks for the mainnet smoke run. Verifies operator key files
# exist, the hub is up and reports Taiko mainnet, contract bytecode is
# present at the expected addresses, USDC + ETH balances meet the per-cap
# minimums, and the hub hot-wallet stays under the 1000 USDC ceiling.
#
# Usage:
#   scripts/mainnet-smoke/00-precheck.sh \
#     --hub <https://hub.example> \
#     --hub-hot-wallet <0x...> \
#     [--rpc <url>]
#
# Exits non-zero on any failure with a colored summary.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"
# shellcheck source=lib/chain.sh
. "$HERE/lib/chain.sh"
# shellcheck source=lib/env.sh
. "$HERE/lib/env.sh"

HUB_URL=""
HUB_HOT_WALLET=""
RPC_URL="${RPC_URL:-$TAIKO_MAINNET_RPC_DEFAULT}"

usage() { sed -n '/^# Usage/,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hub) HUB_URL="$2"; shift 2 ;;
    --hub-hot-wallet) HUB_HOT_WALLET="$2"; shift 2 ;;
    --rpc) RPC_URL="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) red "unknown arg: $1"; usage ;;
  esac
done

[[ -n "$HUB_URL" ]] || fail "--hub is required"
[[ -n "$HUB_HOT_WALLET" ]] || fail "--hub-hot-wallet is required (CLI gap: hub /v1/health does not expose its hot-wallet address)"
require_cast

LOG_DIR="$(resolve_log_dir)"
log "Logs: $LOG_DIR"

declare -i fail_count=0
note() { echo "  $*" >&2; }
ok()   { green "  OK  $*"; }
bad()  { red   "  FAIL $*"; fail_count+=1; }

# --- Operator key files ---
yellow "[1/5] Operator key files"
for role in "${ROLES[@]}"; do
  if [[ -f "$(operator_key_file "$role")" ]]; then
    addr="$(operator_address "$role" || echo '<unknown>')"
    ok "$role key.enc present (address: $addr)"
  else
    bad "$role key.enc missing at $(operator_key_file "$role")"
  fi
done

# --- Hub liveness + chain identity ---
yellow "[2/5] Hub liveness"
if hub_health="$(curl -fsS "$HUB_URL/v1/health" 2>/dev/null)"; then
  ok "$HUB_URL responded"
  echo "$hub_health" > "$LOG_DIR/hub-health.json"
else
  bad "$HUB_URL did not respond"
fi

yellow "[3/5] Chain identity"
chain="$(chain_id "$RPC_URL")"
if [[ "$chain" == "$TAIKO_MAINNET_CHAIN_ID" ]]; then
  ok "RPC reports Taiko mainnet (chainId $chain)"
else
  bad "RPC reports chainId $chain — expected $TAIKO_MAINNET_CHAIN_ID"
fi

# --- Contract bytecode parity ---
yellow "[4/5] Contract bytecode"
for pair in "PaymentChannel:$PAYMENT_CHANNEL_ADDR" "Adjudicator:$ADJUDICATOR_ADDR" "USDC:$USDC_ADDR"; do
  name="${pair%%:*}"; addr="${pair##*:}"
  size="$(contract_codesize "$addr" "$RPC_URL")"
  if [[ "$size" -gt 0 ]]; then
    ok "$name @ $addr — ${size} bytes of code"
  else
    bad "$name @ $addr — NO CODE (mainnet RPC misconfigured?)"
  fi
done

# --- Balances ---
yellow "[5/5] Balances"
MIN_USDC_OPERATOR=$((100 * 10**USDC_DECIMALS))
MIN_ETH_WEI=$(python3 -c 'print(int(0.005 * 10**18))')
HUB_USDC_CEILING=$((1000 * 10**USDC_DECIMALS))

for role in "${ROLES[@]}"; do
  addr="$(operator_address "$role" 2>/dev/null || echo '')"
  if [[ -z "$addr" ]]; then
    bad "$role address could not be resolved (key.enc missing or CLI failed)"
    continue
  fi
  usdc="$(usdc_balance "$addr" "$RPC_URL")"
  eth="$(eth_balance_wei "$addr" "$RPC_URL")"
  if (( $(python3 -c "print(1 if int('$usdc') >= int('$MIN_USDC_OPERATOR') else 0)") )); then
    ok "$role USDC OK (raw: $usdc, addr: $addr)"
  else
    bad "$role USDC below 100 USDC cap (raw: $usdc, addr: $addr)"
  fi
  if (( $(python3 -c "print(1 if int('$eth') >= int('$MIN_ETH_WEI') else 0)") )); then
    ok "$role ETH OK (raw wei: $eth)"
  else
    bad "$role ETH below 0.005 minimum (raw wei: $eth)"
  fi
done

hub_usdc="$(usdc_balance "$HUB_HOT_WALLET" "$RPC_URL")"
if (( $(python3 -c "print(1 if int('$hub_usdc') <= int('$HUB_USDC_CEILING') else 0)") )); then
  ok "Hub hot wallet USDC under 1000 USDC ceiling (raw: $hub_usdc, addr: $HUB_HOT_WALLET)"
else
  bad "Hub hot wallet USDC ABOVE 1000 USDC ceiling — DRAIN BEFORE PROCEEDING (raw: $hub_usdc)"
fi

# --- Summary ---
echo
if (( fail_count == 0 )); then
  green "Precheck OK — proceed to 01-open-channels.sh"
  echo "{\"status\":\"ok\",\"hub\":\"$HUB_URL\",\"rpc\":\"$RPC_URL\",\"chain\":$TAIKO_MAINNET_CHAIN_ID}" \
    > "$LOG_DIR/precheck.json"
  exit 0
else
  red "Precheck FAILED with $fail_count issue(s) — fix before proceeding"
  echo "{\"status\":\"fail\",\"failed\":$fail_count}" > "$LOG_DIR/precheck.json"
  exit 1
fi
