#!/usr/bin/env bash
# cast / curl wrappers for chain reads. Sourced.

set -euo pipefail

# Pinned mainnet constants (mirror packages/protocol/src/constants.ts).
TAIKO_MAINNET_CHAIN_ID=167000
TAIKO_MAINNET_RPC_DEFAULT="https://rpc.mainnet.taiko.xyz"
PAYMENT_CHANNEL_ADDR="0x07B32f52523Fdf0780821595422DccEF31FA2335"
ADJUDICATOR_ADDR="0x775904054b4A97b3925f1Dd60aE61fBc81567dB9"
USDC_ADDR="0x07d83526730c7438048D55A4fc0b850e2aaB6f0b"
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
