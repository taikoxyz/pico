# @inferenceroom/pico-protocol

## 2.1.7

### Patch Changes

- c8ce5c5: Round-4 follow-up — make per-counterparty HTLC cap per-token.

  **state-machine + hub (HIGH)**: `MAX_HTLC_VALUE_PER_COUNTERPARTY = 1e8`
  is the USDC default (100 USDC at 6 decimals). For an 18-decimal channel
  token (native ETH, PTST) the same scalar clamps payment to 1e-10 of the
  token, so even a 0.00001 ETH payment (1e13 wei) was rejected by the
  router with `per-counterparty inflight would exceed 100000000`.

  `HtlcAdmissionContext` now accepts an optional `maxPerCounterpartyValue`
  in the channel-token's base units; the hub router fills it in
  per-token (1 ETH / 100 PTST / 100 USDC), and `checkHtlcAdmissible`
  falls back to the legacy scalar when the field is omitted so existing
  unit tests stay green.

  Like the `topup-policy` PTST entry, the test-token override should be
  promoted to operator-configurable env vars before more allowlisted
  ERC-20s ship to production.

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

## 2.1.0

## 2.0.3

### Patch Changes

- b9952b4: Redeploy v2 contracts on Taiko mainnet. The previous proxies (v1.0) used the
  old EIP-712 typehash `("pico","1")` and lacked HTLC settlement / native ETH /
  `topUp` / `closeUnilateralFromOpen`. Fresh proxies, allowlisting USDC + native
  ETH, replace them. The hub and watchtower funded addresses are preserved.

  New Taiko mainnet addresses:

  - PaymentChannel: `0xA2665f2Fdf23CAA362b63F7A8902466f0504332d`
  - Adjudicator: `0x8C913a936F99e93e298f7800f14C46C32D71e26B`

## 2.0.2

### Patch Changes

- 0927067: End-to-end test of the Changesets + GitHub Actions OIDC trusted-publishing pipeline. No code changes; verifies that the auto-generated "Version Packages" PR + npm provenance flow works for all five publishable packages.

## 2.0.1

### Major Changes

- 78d4fdd: release 1.0.1

### Patch Changes

- release 2.0.1

## 1.0.0

### Major Changes

- First release.
