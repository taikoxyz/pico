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
#     --expected-owner <0xSafeOrTimelock> \
#     [--timelock <0xTimelock> --safe <0xSafe>] \
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
EXPECTED_OWNER="${EXPECTED_OWNER:-}"
TIMELOCK_ADDRESS="${TIMELOCK_ADDRESS:-}"
SAFE_ADDRESS="${SAFE_ADDRESS:-}"
RPC_URL="${RPC_URL:-$TAIKO_MAINNET_RPC_DEFAULT}"

usage() { sed -n '/^# Usage/,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hub) HUB_URL="$2"; shift 2 ;;
    --hub-hot-wallet) HUB_HOT_WALLET="$2"; shift 2 ;;
    --expected-owner) EXPECTED_OWNER="$2"; shift 2 ;;
    --timelock) TIMELOCK_ADDRESS="$2"; shift 2 ;;
    --safe) SAFE_ADDRESS="$2"; shift 2 ;;
    --rpc) RPC_URL="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) red "unknown arg: $1"; usage ;;
  esac
done

[[ -n "$HUB_URL" ]] || fail "--hub is required"
[[ -n "$HUB_HOT_WALLET" ]] || fail "--hub-hot-wallet is required (CLI gap: hub /v1/health does not expose its hot-wallet address)"
[[ -n "$EXPECTED_OWNER" ]] || fail "--expected-owner is required"
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
yellow "[4/6] Contract bytecode + governance"
for pair in "PaymentChannel:$PAYMENT_CHANNEL_ADDR" "Adjudicator:$ADJUDICATOR_ADDR" "USDC:$USDC_ADDR"; do
  name="${pair%%:*}"; addr="${pair##*:}"
  size="$(contract_codesize "$addr" "$RPC_URL")"
  if [[ "$size" -gt 0 ]]; then
    ok "$name @ $addr — ${size} bytes of code"
  else
    bad "$name @ $addr — NO CODE (mainnet RPC misconfigured?)"
  fi
done

owner_pc="$(contract_owner "$PAYMENT_CHANNEL_ADDR" "$RPC_URL")"
owner_adj="$(contract_owner "$ADJUDICATOR_ADDR" "$RPC_URL")"
if [[ "${owner_pc,,}" == "${EXPECTED_OWNER,,}" && "${owner_adj,,}" == "${EXPECTED_OWNER,,}" ]]; then
  ok "Both proxies owned by expected owner $EXPECTED_OWNER"
else
  bad "Proxy owner mismatch: PaymentChannel=$owner_pc Adjudicator=$owner_adj expected=$EXPECTED_OWNER"
fi

owner_code_size="$(contract_codesize "$EXPECTED_OWNER" "$RPC_URL")"
if [[ "$owner_code_size" -gt 0 ]]; then
  ok "Expected owner has contract code (${owner_code_size} bytes)"
else
  bad "Expected owner $EXPECTED_OWNER has no code; verify Safe/timelock deployment before real funds"
fi

if [[ "$(token_allowed "$USDC_ADDR" "$RPC_URL")" == "true" ]]; then
  ok "PaymentChannel allows canonical USDC $USDC_ADDR"
else
  bad "PaymentChannel does not allow canonical USDC $USDC_ADDR"
fi

if [[ -n "$TIMELOCK_ADDRESS" ]]; then
  delay="$(timelock_delay "$TIMELOCK_ADDRESS" "$RPC_URL")"
  if (( $(python3 -c "print(1 if int('$delay') >= 172800 else 0)") )); then
    ok "Timelock delay >= 48h (raw seconds: $delay)"
  else
    bad "Timelock delay below 48h (raw seconds: $delay)"
  fi
  if [[ -n "$SAFE_ADDRESS" ]]; then
    if [[ "$(timelock_has_role "$TIMELOCK_ADDRESS" PROPOSER_ROLE "$SAFE_ADDRESS" "$RPC_URL")" == "true" ]]; then
      ok "Safe has Timelock PROPOSER_ROLE"
    else
      bad "Safe lacks Timelock PROPOSER_ROLE"
    fi
    if [[ "$(timelock_has_role "$TIMELOCK_ADDRESS" EXECUTOR_ROLE "$SAFE_ADDRESS" "$RPC_URL")" == "true" ]]; then
      ok "Safe has Timelock EXECUTOR_ROLE"
    else
      bad "Safe lacks Timelock EXECUTOR_ROLE"
    fi
  fi
fi

# --- Balances ---
yellow "[5/6] Balances"
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
yellow "[6/6] Summary"
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
