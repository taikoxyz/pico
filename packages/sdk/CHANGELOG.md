# @inferenceroom/pico-sdk

## 2.1.6

### Patch Changes

- 72855ef: Round-4 follow-up — chain.topUp RPC-lag retry and PTST per-token defaults.

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

- Updated dependencies [72855ef]
  - @inferenceroom/pico-protocol@2.1.6

## 2.1.5

### Patch Changes

- 3a5b8c8: Round-4 follow-up — pass the channel's actual token to `chain.topUp`.

  **hub (HIGH)**: when the user accepts a `proposeTopUp`, `TopUpHandler`
  was passing `this.deps.token` to `chain.topUp(...)`. That field is set
  at server startup from "the first registered channel's token" — for a
  mixed-token hub (e.g. a USDC channel registered before any ETH
  channel) every native-ETH topUp got submitted as an ERC-20 transfer
  and the contract reverted with `ETH value!=amount` because the chain
  adapter only sets `value: amount` when the token argument is
  `address(0)`. Pass `channel.token` from the per-offer channel record
  instead.

- Updated dependencies [3a5b8c8]
  - @inferenceroom/pico-protocol@2.1.5

## 2.1.4

### Patch Changes

- 1a2c349: Round-4 hotfix — restart-safe sentinel signatures.

  **hub (CRITICAL)**: the chain-watcher and topup-handler defined
  `SENTINEL_SIG` with `r: EMPTY_SIG_BYTES, s: EMPTY_SIG_BYTES` — but a
  `Signature.r`/`s` is 32 bytes, while `EMPTY_SIG_BYTES` is the full
  65-byte sig blob. Serializing this sentinel via `signatureToHex`
  produced a 264-character all-zero hex string that was persisted into
  the hub's `signed_states` table by the v2.1.2 chain-watcher bootstrap
  path. On the next pod restart, `StateRepo.loadAllLatest` called
  `hexToSignature` on those rows and threw
  `Error: expected 65-byte hex signature, got length 264`,
  crash-looping the hub.

  Fixes: `SENTINEL_SIG` in both `chain-watcher.ts` and `topup-handler.ts`
  now use proper 32-byte zero `r`/`s`. `hexToSignature` (in
  `@inferenceroom/pico-sdk`) tolerates the legacy 264-char all-zero blob
  as a sentinel so previously-persisted rows hydrate without throwing.

- Updated dependencies [1a2c349]
  - @inferenceroom/pico-protocol@2.1.4

## 2.1.3

### Patch Changes

- 003be59: Round-4 mainnet smoke findings (issue #100 follow-up) — fixes two production
  blockers in v2.1.2.

  **hub (HIGH)**: §8 inbound-liquidity policy lowered `defaultOfferAmount` for
  native ETH from `0.05 ETH` → `0.0001 ETH`. With a hub hot-wallet of `0.05
ETH`, the prior default exhausted headroom after a single channel and every
  subsequent open returned `topup: queuing — admission policy rejected`. The
  new default lets `0.05 ETH` service ~500 channels; the per-channel and
  per-counterparty caps (`0.1 ETH` / `1 ETH`) are unchanged, so the hub can
  still grow inbound to a given user via repeat top-ups.

  **hub (HIGH)**: dispute-handler now skips submitting any state whose
  `sigA`/`sigB` is a sentinel (`r=s=0`). The chain-watcher bootstrap (PR
  #102) seeds a v0 sentinel-signed state into the channel pool so the router
  has something to apply HTLC updates onto; if that channel is later seen to
  close unilaterally on-chain, the hub previously busy-looped
  `dispute(...)` calls that reverted with `bad sig`, polluting logs and
  wasting RPC every poll for ~24 h until the dispute deadline elapsed.

- Updated dependencies [003be59]
  - @inferenceroom/pico-protocol@2.1.3

## 2.1.2

### Patch Changes

- 375bb84: Round-3 mainnet smoke findings (issue #100) — fixes #4, #7, #9-#15.

  **hub (#9-#11)**: §8 inbound-liquidity layer now works for native-ETH
  channels. `defaultOfferAmount` resolves per-token (0.05 ETH for
  native, 5 USDC for USDC), proposed offers re-push to the user on
  every WS subscribe, and the chain-watcher bootstrap seeds a sentinel-
  signed v0 state so the router can apply HTLC updates onto fresh
  channels. Combined with PR #99 (CLI/SDK ETH support) and PR #102
  (chain-watcher bootstrap), `pico pay --json` now returns
  `status: settled` end-to-end for native ETH.

  **SDK (#13)**: `ViemChainAdapter` writes use `maxFeePerGas = 4 ×
basefee + tip` (or `gasPrice = 4 × eth_gasPrice` on legacy chains)
  so close/open/topup txs don't get stuck in mempool when viem's
  default `eth_gasPrice` underestimates the chain floor.

  **CLI (#4, #7, #14, #15)**: `pico channel open` exits 0 when only
  the WS subscribe times out (the channel is on-chain and persisted);
  checks `minChannelAmount[token]` before submission to surface a clear
  error instead of `chain error: Contract Call:`. `pico channel close`
  auto-routes to `close-from-open` when no off-chain state exists.
  `pico keys drain` uses inflated gas math matching the SDK and swallows
  native-sweep failures into a `nativeSkipped` warning so token sweeps
  still count.

  **release infra (#12)**: `release.yml`'s Docker-tag step now diffs
  deploy-relevant package versions against the last `v*` tag rather
  than gating on `changesets.outputs.published`. Combined with
  `continue-on-error: true` on the changesets/action step, GKE deploys
  fire reliably even when the (unrelated) npm publish 404 happens.

  **hub (#3)**: `/v1/health.version` reports the real release tag
  (`HUB_RELEASE_TAG` → `package.json` → `npm_package_version` →
  `0.0.0`) instead of always `'0.0.0'`.

  **CLI (#5, #6)**: `pico invoice create --amount` and `pico pay
--amount` help text is now token-agnostic. `pico channel open`/`close`
  print the on-chain tx hash in both pretty and JSON output (verified;
  README annotation updated).

- Updated dependencies [375bb84]
  - @inferenceroom/pico-protocol@2.1.2

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
