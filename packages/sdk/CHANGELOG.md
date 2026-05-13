# @inferenceroom/pico-sdk

## 2.1.1

### Patch Changes

- 10eee8a: fix(hub): bootstrap unknown channels from `ChannelOpened` events

  Round-2 mainnet smoke (HIGH finding #1, issue #100) showed the hub
  chain-watcher only updated channels already in the pool on `ChannelOpened`.
  Newly-opened channels were never registered, so the WS envelope check —
  which builds known-signers from `channelPool.list()` — rejected every
  legitimate first message from a fresh channel's party with
  "`signer … not a known channel party`", and `pico channel open` then
  errored with `subscribe timed out`.

  The watcher now registers the channel into the pool when `ChannelOpened`
  fires for an unknown channelId, using event-emitted
  `userA`/`userB`/`token`/`amountA`/`amountB` and the block timestamp for
  `openedAt`. If `getBlock` fails, `openedAt` falls back to wall-clock time
  (rather than `0` / Jan 1 1970, which would mislead any consumer comparing
  `openedAt + disputeWindowMs` against now). Post-bootstrap, the WS
  handshake succeeds normally.

  Hub-only change; no SDK/protocol API surface impact. The patch bumps here
  exist only so the deploy-relevant package list in `release.yml` cuts a
  new `v*` tag for the GKE image pipeline to pick up.

- Updated dependencies [10eee8a]
  - @inferenceroom/pico-protocol@2.1.1

## 2.1.0

### Minor Changes

- 3b0b5fa: Fix the P0 envelope mismatch and ship a batch of CLI UX improvements
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
  - **Native ETH channels end-to-end.** `openChannel` and `topUp` now pass
    `value: amount` when `token === 0x0000…0000`, and the `topUp` ABI entry
    is `payable` so viem's type-check accepts `value`. `readTokenDecimals`
    short-circuits `address(0)` to 18. ETH and ERC-20 paths are both unit-
    tested in `chain-adapter.viem.test.ts`.
  - **`PostOpenSubscribeError`.** New exported error thrown by
    `ChannelClient.open()` when the on-chain open succeeds but the subsequent
    hub subscribe fails (timeout, hub down, indexer gap). Carries the
    persisted `OpenedChannel` (channelId, txHash, blockNumber) plus the
    underlying cause so operators can resume with `pico listen` instead of
    losing the freshly-opened channel.

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
    - listed ERC-20 balances to a target address. For cleaning up ephemeral
      smoke-test wallets.
  - `pico channel open` now supports **native ETH** (`--token 0x0000…0000`):
    skips the ERC-20 approve block and uses the native-value path. Works on
    chains where `address(0)` is allowlisted (e.g. Taiko mainnet v2).
  - `pico channel open` catches `PostOpenSubscribeError`: prints
    `channelId` / `tx hash` / `block` in both JSON and human modes, writes a
    recovery hint to stderr (`run \`pico listen\` to resume`), and exits 1
    so scripts still treat partial success as failure.

  ## Test utils

  - `startMockHub` now mirrors the production hub's non-strict mode and
    accepts both wrapped and unwrapped messages, so SDK consumers that wrap
    by default still work against the in-memory mock.

### Patch Changes

- @inferenceroom/pico-protocol@2.1.0

## 2.0.3

### Patch Changes

- Updated dependencies [b9952b4]
  - @inferenceroom/pico-protocol@2.0.3

## 2.0.2

### Patch Changes

- 0927067: End-to-end test of the Changesets + GitHub Actions OIDC trusted-publishing pipeline. No code changes; verifies that the auto-generated "Version Packages" PR + npm provenance flow works for all five publishable packages.
- Updated dependencies [0927067]
  - @inferenceroom/pico-protocol@2.0.2
  - @inferenceroom/pico-state-machine@2.0.2

## 2.0.1

### Major Changes

- 78d4fdd: release 1.0.1

### Patch Changes

- release 2.0.1
- Updated dependencies
- Updated dependencies [78d4fdd]
  - @inferenceroom/pico-protocol@2.0.1
  - @inferenceroom/pico-state-machine@2.0.1

## 1.0.0

### Major Changes

- First release.

### Patch Changes

- Updated dependencies
  - @inferenceroom/pico-state-machine@1.0.0
  - @inferenceroom/pico-protocol@1.0.0
