#!/usr/bin/env bash
# Orchestrate the full mainnet smoke flow. Prompts before each phase so the
# operator can pause and inspect; pass --yes (or YES=1) to skip prompts.
#
# Usage:
#   scripts/mainnet-smoke/run-all.sh \
#     --hub <https://hub.example> \
#     --hub-hot-wallet <0x...> \
#     --expected-owner <0xSafeOrTimelock> \
#     [--timelock <0xTimelock> --safe <0xSafe>] \
#     [--amount-usdc 10] \
#     [--pay-amount-usdc 1] \
#     [--rpc <url>] \
#     [--yes]

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/lib/common.sh"
. "$HERE/lib/chain.sh"

HUB_URL=""
HUB_HOT_WALLET=""
EXPECTED_OWNER="${EXPECTED_OWNER:-}"
TIMELOCK_ADDRESS="${TIMELOCK_ADDRESS:-}"
SAFE_ADDRESS="${SAFE_ADDRESS:-}"
AMOUNT_USDC=10
PAY_AMOUNT_USDC=1
RPC_URL="${RPC_URL:-$TAIKO_MAINNET_RPC_DEFAULT}"

usage() { sed -n '/^# Usage/,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --hub) HUB_URL="$2"; shift 2 ;;
    --hub-hot-wallet) HUB_HOT_WALLET="$2"; shift 2 ;;
    --expected-owner) EXPECTED_OWNER="$2"; shift 2 ;;
    --timelock) TIMELOCK_ADDRESS="$2"; shift 2 ;;
    --safe) SAFE_ADDRESS="$2"; shift 2 ;;
    --amount-usdc) AMOUNT_USDC="$2"; shift 2 ;;
    --pay-amount-usdc) PAY_AMOUNT_USDC="$2"; shift 2 ;;
    --rpc) RPC_URL="$2"; shift 2 ;;
    --yes) export YES=1; shift ;;
    -h|--help) usage ;;
    *) fail "unknown arg: $1" ;;
  esac
done
[[ -n "$HUB_URL" ]] || fail "--hub is required"
[[ -n "$HUB_HOT_WALLET" ]] || fail "--hub-hot-wallet is required"
[[ -n "$EXPECTED_OWNER" ]] || fail "--expected-owner is required"

# Pin the log dir for the whole run so all phases share it.
export LOG_DIR="scripts/mainnet-smoke/log/$(date -u +%Y%m%d-%H%M%S)"
mkdir -p "$LOG_DIR"
log "Run log dir: $LOG_DIR"

phase() {
  local name="$1"; shift
  echo
  blue "=== $name ==="
  if confirm "Run $name?"; then
    "$@"
  else
    yellow "Skipped $name"
  fi
}

precheck_args=(--hub "$HUB_URL" --hub-hot-wallet "$HUB_HOT_WALLET" --expected-owner "$EXPECTED_OWNER" --rpc "$RPC_URL")
if [[ -n "$TIMELOCK_ADDRESS" ]]; then precheck_args+=(--timelock "$TIMELOCK_ADDRESS"); fi
if [[ -n "$SAFE_ADDRESS" ]]; then precheck_args+=(--safe "$SAFE_ADDRESS"); fi

phase "00-precheck"          "$HERE/00-precheck.sh"          "${precheck_args[@]}"
phase "01-open-channels"     "$HERE/01-open-channels.sh"     --hub "$HUB_URL" --amount-usdc "$AMOUNT_USDC" --rpc "$RPC_URL"
phase "02-pay"               "$HERE/02-pay.sh"               --hub "$HUB_URL" --amount-usdc "$PAY_AMOUNT_USDC"
phase "03-cooperative-close" "$HERE/03-cooperative-close.sh" --hub "$HUB_URL" --rpc "$RPC_URL"
phase "04-dispute-drill"     "$HERE/04-dispute-drill.sh"     --hub "$HUB_URL" --rpc "$RPC_URL"
phase "05-finalize"          "$HERE/05-finalize.sh"

green "All phases complete. Review $LOG_DIR and the assembled log."
