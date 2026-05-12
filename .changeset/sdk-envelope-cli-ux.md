---
"@inferenceroom/pico-sdk": minor
"@inferenceroom/pico-cli": minor
"@inferenceroom/pico-test-utils": minor
---

Fix the P0 envelope mismatch and ship a batch of CLI UX improvements
surfaced by the Taiko mainnet v2 smoke run.

## SDK

- `WebSocketTransport` now wraps outgoing `ClientToHubMessage`s in signed
  envelopes (`{ nonce, ts, payload, sig }`) when a `Signer` is provided.
  This is required against hubs running with `HUB_REQUIRE_SIGNED_ENVELOPE=true`
  (production). Without it the hub silently dropped subscribes and clients
  saw a misleading `"WebSocket error"`.
- `Signer.signEnvelope(digest)` is the new raw-secp256k1 primitive (no
  EIP-191 prefix). `LocalSigner` + `InMemorySigner` implement it.
- `buildEnvelope` / `envelopeDigest` / `looksLikeSignedEnvelope` are exported
  from `@inferenceroom/pico-sdk`.
- `ChannelClient.open()` now returns `{ channel, txHash, blockNumber }` so
  CLI / agent code can log the on-chain tx hash. `close()` similarly returns
  `{ kind, txHash, blockNumber }`. `closeUnilateralFromOpen()` adds
  `blockNumber`. `OpenChannelOnChainResult` / `CloseOnChainResult` /
  `CloseUnilateralOnChainResult` all expose `blockNumber`.

## Hub

- In non-strict mode (`HUB_REQUIRE_SIGNED_ENVELOPE=false`), the hub now
  auto-detects wrapped envelopes and unwraps them — so an envelope-emitting
  SDK works against dev hubs without flipping the flag.

## CLI

- `pico channel open` is **decimal-aware**: `--amount 10` means 10 PTST on
  an 18-decimal token. Pass `--raw-amount` for the old base-units behavior.
- `pico channel open` **auto-approves** the PaymentChannel for ERC-20 spend
  when the current allowance is short. Pass `--no-approve` to opt out.
- `pico channel open` / `close` now print the on-chain `tx hash` and
  `block` number (plus `channelId`), in both human and JSON modes.
- `--via` defaults to the chain-canonical hub URL
  (`wss://hub.pico.taiko.xyz/ws` for Taiko mainnet), or `$PICO_HUB_URL` if
  set. A warning is printed when `--via` points at localhost while the
  chain is mainnet.
- CLI errors are categorized: chain reverts surface as `chain error: …`
  with viem's decoded reason, transport timeouts as `hub error: …`, WS
  errors as `ws error: …`. No more silent `"WebSocket error"` swallowing
  an on-chain revert.
- `pico hub status <url>` now hits `/v1/health` + `/v1/info` + `/v1/stats`
  in parallel and prints hub address, chain id, contract addresses, and
  channel counts.
- `pico keys drain --to <addr> [--tokens ...]` sweeps residual native ETH
  + listed ERC-20 balances to a target address. For cleaning up ephemeral
  smoke-test wallets.

## Test utils

- `startMockHub` now mirrors the production hub's non-strict mode and
  accepts both wrapped and unwrapped messages, so SDK consumers that wrap
  by default still work against the in-memory mock.
