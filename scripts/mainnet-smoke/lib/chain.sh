#!/usr/bin/env bash
# cast / curl wrappers for chain reads. Sourced.

set -euo pipefail

# Mainnet defaults mirror packages/protocol/src/constants.ts. Override any of
# these via env to point the smoke harness at a different deployment without
# editing source — same env-var names that hub/watchtower honor.
TAIKO_MAINNET_CHAIN_ID=167000
TAIKO_MAINNET_RPC_DEFAULT="https://rpc.mainnet.taiko.xyz"
PAYMENT_CHANNEL_ADDR="${PAYMENT_CHANNEL_ADDRESS:-${PAYMENT_CHANNEL_ADDR:-0xCDEF7911155c8db64Ef810Ae8C538024550594D7}}"
ADJUDICATOR_ADDR="${ADJUDICATOR_ADDRESS:-${ADJUDICATOR_ADDR:-0xee660F9c471d833f092Bc79f5c8F9943469b0e05}}"
USDC_ADDR="${USDC_ADDRESS:-${USDC_ADDR:-0x07d83526730c7438048D55A4fc0b850e2aaB6f0b}}"
USDC_DECIMALS=6

require_cast() {
  command -v cast >/dev/null 2>&1 || fail "foundry's 'cast' is required on PATH (https://getfoundry.sh)"
}

chain_id() {
  local rpc="$1"
  cast chain-id --rpc-url "$rpc"
}

eth_balance_wei() {
  local addr="$1" rpc="$2"
  cast balance "$addr" --rpc-url "$rpc"
}

usdc_balance() {
  local addr="$1" rpc="$2"
  cast call "$USDC_ADDR" "balanceOf(address)(uint256)" "$addr" --rpc-url "$rpc"
}

contract_codesize() {
  local addr="$1" rpc="$2"
  local code
  code=$(cast code "$addr" --rpc-url "$rpc")
  echo $(( (${#code} - 2) / 2 ))
}

contract_owner() {
  local addr="$1" rpc="$2"
  cast call "$addr" "owner()(address)" --rpc-url "$rpc"
}

token_allowed() {
  local token="$1" rpc="$2"
  cast call "$PAYMENT_CHANNEL_ADDR" "allowedTokens(address)(bool)" "$token" --rpc-url "$rpc"
}

timelock_delay() {
  local addr="$1" rpc="$2"
  cast call "$addr" "getMinDelay()(uint256)" --rpc-url "$rpc"
}

timelock_has_role() {
  local addr="$1" role_sig="$2" account="$3" rpc="$4"
  local role
  role="$(cast call "$addr" "$role_sig()(bytes32)" --rpc-url "$rpc")"
  cast call "$addr" "hasRole(bytes32,address)(bool)" "$role" "$account" --rpc-url "$rpc"
}

# Best-effort: resolve the most recent ChannelOpened tx hash for a given
# channel id by scanning recent blocks. Slow on a fresh fork; fine after
# the actual open since the operator has the block range narrowed.
channel_opened_tx() {
  local channel_id="$1" rpc="$2" from_block="${3:-latest-100}"
  local sig="ChannelOpened(bytes32,address,address,address,uint256)"
  cast logs --address "$PAYMENT_CHANNEL_ADDR" \
    --from-block "$from_block" --to-block latest \
    "$sig" "$channel_id" --rpc-url "$rpc" \
    --json 2>/dev/null | head
}
