---
'@inferenceroom/pico-protocol': patch
'@inferenceroom/pico-sdk': patch
---

Round-4 follow-up — chain.topUp RPC-lag retry and PTST per-token defaults.

**sdk (HIGH)**: `ViemChainAdapter.topUp` now polls the on-chain channel
status before submitting the on-chain `topUp(...)`. On Taiko mainnet's
public RPC the chain-watcher's `latest`-block view and `eth_estimateGas`'s
`latest`-block view sometimes disagree by a block when a `ChannelOpened`
event is followed within seconds by an `acceptTopUp` round-trip — the
`estimateGas` simulation sees a default-zero channel (`status == None`),
the contract reverts with `!open`, and the hub marks the offer
`rejected` with no retry path. The new pre-flight polls
`channels(channelId).status` up to 8 × 1 s and proceeds when it reads
`Open`. If the channel really is not open after that, the subsequent
`writeContract` still surfaces the on-chain revert.

**hub (medium)**: `DEFAULT_TOPUP_POLICY` adds a per-token override for
the PTST mainnet test ERC-20 (`0x3CF2321323C23c9F91daFe99E2b121cab5cE3759`)
so 18-decimal allowlisted ERC-20 channels no longer resolve to the
USDC-shaped scalar (`5_000_000n = 5e-12 PTST`). 2 / 10 / 100 PTST
offer/channel/counterparty caps. Note: the test-token override should
be promoted to operator-configurable env vars before more allowlisted
ERC-20s are added in production.
