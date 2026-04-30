# P8 — E2E + internal audit

**Status:** 🟡 **Phase 2 substantially done** — Phase 1 + 2A + 2B + 2C +
hot-key rotation = 11 scenarios green via real hub + watchtower
(`pnpm -F @tainnel/e2e test` → 11 passed, 2 deferred, ~3s). Remaining
deferred: hub-down recovery (gates on durable channel pool, separate
PR), receiver-offline (gates on CLI journal replay, separate PR), and
Phase 3 (audit).
**Blocks:** P9, P10
**Effort:** Phase 1 ~5–9h ✅. Phase 2 ~1 week (2A ✅, 2B ✅, 2C ✅, 2D
partial — hot-key ✅; durability deferred).

## Why this exists as its own phase

P2–P7 each verify their own surface in isolation. P8 is the only place where
the **whole stack** is exercised: contracts + state machine + SDK + hub +
watchtower + agent runtime (CLI) all running together. This is also where you,
the human, sit down and read the most safety-critical code top-to-bottom.

## Strategy: ratchet from minimum

Rather than wait until every component is production-ready and then write a
multi-hop HTLC test, we land **one** end-to-end scenario early — using only
parts that already exist or can be stubbed minimally — and use it as a CI
gate. Subsequent scenarios are added one at a time as the underlying
primitives (hub router, watchtower, dispute handler, CLI) come online.

- **Phase 1**: alice → hub, 2 parties, vanilla anvil, own MockUSDC, in-memory
  hub. **Goal: a green E2E in CI.**
- **Phase 2**: full lifecycle scenarios (HTLC, multi-hop, dispute, watchtower,
  unilateral close, key rotation, hub-down recovery, replay, fuzz). Reuse the
  Phase 1 harness; switch the in-memory test hub for the real `apps/hub`.
- **Phase 3**: internal audit checklist below — read every safety-critical file
  top to bottom.

## Decisions

### D8.1 External audit before mainnet?
- **Default:** **no external audit** for the dogfood scope (you chose option C
  during brainstorming: dogfood / private with real money on Taiko mainnet,
  no whitelist, ~1–2 month horizon).
- If you change your mind later, this is the gate to add it before P10.
- Decision: ☑ no audit (dogfood path) ☐ ask one external reviewer ☐ paid audit

### D8.2 Bug bounty?
- **Default:** **no** for v1. Revisit if scope expands.
- Decision: ☑ no ☐ Immunefi ☐ self-managed page

### D8.3 Chain target per phase
- **Phase 1: vanilla anvil** (chainId 31337), no fork. Own `MockERC20`
  ("USDC", 6 decimals) deployed each test boot. Hermetic, fast (~1.7s for
  6 scenarios), no external RPC dependency.
- **Phase 2: anvil forking Taiko mainnet** (chainId 167000, pinned block).
  Reuses the Phase 1 harness; swaps the deploy step for `--fork-url
  $TAIKO_MAINNET_RPC_URL --fork-block-number <pinned>` and points the SDK
  at the existing on-chain `PaymentChannel` / `Adjudicator` / bridged USDC
  addresses (already in `packages/protocol/src/constants.ts`). This gives
  fee + precompile + state parity with mainnet without spending real funds.
  **Real-money mainnet stays in P10**, not here.
- Decision: ☑ Phase 1 vanilla anvil + own MockUSDC, ☑ Phase 2 anvil fork of
  Taiko mainnet

---

## Phase 1 — alice → hub 2-party cooperative close

The smallest end-to-end slice that exercises real contracts + real SDK + a
minimal real hub: Alice opens a channel with the hub, sends one direct
(non-HTLC) balance update granting the hub 5 USDC, and cooperatively closes.

### Test harness — `e2e/src/harness.ts`

- [x] `[agent]` Spin up vanilla anvil (no fork) via the existing
      `startAnvilFork({ chainId: 31337 })` from `@tainnel/test-utils`.
- [x] `[agent]` Deploy `packages/contracts/test/mocks/MockERC20.sol` as USDC
      (6 decimals). Mint 100 USDC to Alice and 100 USDC to Hub.
- [x] `[agent]` Deploy `Adjudicator` + `PaymentChannel` proxies (inline viem
      deploy mirroring `script/Deploy.s.sol`) and call
      `setTokenAllowed(usdc, true)`. Alice + hub approve max USDC.
- [x] `[agent]` Start `startMockHub` from `@tainnel/test-utils` on an
      ephemeral port with `hubPrivateKey = TEST_KEYS.hub.privateKey`.
- [x] `[agent]` Return `E2EHandle { rpcUrl, chainId, usdc, paymentChannel,
      adjudicator, alice, hub, hubServer, publicClient, stop() }`. Plus
      helpers `buildAliceClient(h)` and `timeWarp(rpcUrl, seconds)`.

### Minimal hub for tests — reuse `startMockHub` from `@tainnel/test-utils`

The production `apps/hub/src/server.ts` is largely stubbed today. For Phase 1
we reuse the existing in-memory `startMockHub` from
`packages/sdk/src/_test/mock-hub.ts` (re-exported via `@tainnel/test-utils`)
rather than building a new test-server. It already handles `subscribe`, `pay`
(HTLC), `htlcSettle`, `htlcFail`, and `closeRequest`. We extended it to also
handle `payDirect` (with hub counter-signing when `hubPrivateKey` is set).

- [x] `[agent]` Extended `startMockHub` with `payDirect` handler.
- [ ] `[agent]` (Phase 2) Replace mock-hub with real `apps/hub/src/server.ts`
      once the router/state-machine wiring is implemented.

### SDK gap — direct (non-HTLC) payment

`ChannelClient.pay()` in `packages/sdk/src/client.ts` builds an HTLC. For Phase
1 we need a 2-party balance update without a preimage.

- [x] `[agent]` Added `ChannelClient.payDirect(channelId, { amount })` that
      bumps `version`, recomputes `balanceA`/`balanceB`, keeps
      `htlcsRoot = bytes32(0)`, signs, persists before send (D4.3), sends to
      hub, awaits hub counter-sig, stores both signatures. New
      `payDirect`/`payDirectAck` wire messages added to `hub-protocol.ts`.
- [x] `[agent]` Reused existing state-machine helpers; the new method is a
      thin wrapper that bypasses the HTLC builder.
- [x] `[agent]` Bonus: extended `OpenChannelArgs` with optional
      `counterpartyAmount` so both parties can deposit at open.
- [x] `[agent]` **Bug fix discovered while wiring the test:**
      `ChannelClient.close({cooperative:true})` was sending the unfinalized
      latest state to the contract, which would have reverted on real chains
      with `!finalized`. Now bumps version, sets `finalized=true`, signs,
      sends to hub for counter-sig, then submits.

### The tests — `e2e/src/scenarios.test.ts`

Each test gets a fresh harness via `beforeEach` / `afterEach`. Helpers
`buildAliceClient(h)` and `timeWarp(rpcUrl, seconds)` live in
`e2e/src/harness.ts`. All multi-party / dispute / HTLC scenarios remain
`describe.skip` so they appear in the report but don't run.

- [x] `[agent]` **Happy path**: open 100, payDirect 5, cooperative close →
      alice 95 / hub 105, channel `Status.Closed`.
- [x] `[agent]` **Sequential payDirect**: 5 + 3 + 2 USDC produces versions
      2, 3, 4. After cooperative close: alice 90 / hub 110.
- [x] `[agent]` **No-payment cooperative close**: open then immediately
      close, both wallets restored to original 100 / 100.
- [x] `[agent]` **Both-deposit channel**: alice 60 + hub 40 (uses new
      `OpenChannelArgs.counterpartyAmount`), payDirect 10, close → wallets
      90 / 110.
- [x] `[agent]` **Insufficient balance**: payDirect over balance throws,
      stored state stays at version 1, cooperative close still returns
      original deposits.
- [x] `[agent]` **Unilateral close → finalize**: open, payDirect 5, force
      `closeUnilateral` (cooperative=false), `evm_increaseTime` 24h+1s,
      `chain.finalize(channelId)` → alice 95 / hub 105, channel
      `Status.Closed`.

### CI gate

- [x] `[agent]` Added `e2e` job to `.github/workflows/ci.yml`: installs
      Foundry, clones forge libs, runs `forge build` for artifacts, builds
      TS packages, then `pnpm -F @tainnel/e2e test`. Added to the `ci` gate
      so merges block on e2e failure.

### Phase 1 done when ✅

- [x] `pnpm -F @tainnel/e2e test` reports **6 passed, 0 failed, 3 deferred
      scenarios skipped, runtime ~1.7s** (well under the 30s budget).
- [x] CI runs the e2e job on every PR (PR #9).
- [x] Existing forge / TS unit tests still pass (107 SDK + 49 CLI green).

---

## Phase 2 — full lifecycle scenarios

Sequenced into 4 milestones (2A done; 2B/2C/2D pending). Each scenario
reuses the Phase 1 harness; for fork-mode scenarios, `bootE2E({ forkUrl,
forkBlockNumber })` switches to anvil-forking-Taiko-mainnet (chainId
167000) using the on-chain `PaymentChannel` / `Adjudicator` / bridged
USDC addresses from `packages/protocol/src/constants.ts`.

### 2A — Foundation + replay attack ✅

- [x] `[agent]` Extended `e2e/src/harness.ts` with `BootE2EOptions
      { forkUrl?, forkBlockNumber? }` and a fork-mode branch that:
      starts anvil with `--fork-url`, sets chainId =
      `TAIKO_MAINNET_CHAIN_ID`, skips contract deploys, uses bridged USDC
      address, and funds alice/hub via `anvil_setBalance`. Vanilla mode
      unchanged. New `mode: 'vanilla' | 'fork'` field on `E2EHandle`.
- [x] `[agent]` Two replay-attack scenarios (see "Scenario: replay
      attack" below). Both run in vanilla mode (no fork dependency).
- [x] `[agent]` CI marker added in `.github/workflows/ci.yml` for a
      future `e2e-fork` job; the existing `e2e` job already runs the
      replay scenarios in vanilla mode.

### 2B — 3-party HTLC routing (agent-pay-agent) ✅
- [x] **Real Router** in `apps/hub/src/router.ts` — replaces stub. Routes
      incoming `pay` to outgoing channel: deducts hub fee, shrinks expiry
      by `EXPIRY_BUFFER_MS`, signs new state for outgoing channel,
      tracks inflight `(incoming htlc id ↔ outgoing htlc id)` for
      settle/fail routing in both directions.
- [x] **WS handlers** in `apps/hub/src/api/ws.ts` (new) — handles
      `subscribe`, `pay`, `htlcSettle`, `htlcFail`, `closeRequest`,
      `payDirect`. On `htlcSettle` from recipient, builds settle on
      incoming channel and forwards `paymentSettle` to original sender.
- [x] **Hub config** extended with `chainId`, `paymentChannelAddress`,
      `adjudicatorAddress`, `hubFeeBps`, `hubFeeFlat` (env-driven).
- [x] **Harness uses real hub**: `startRealHub` boots the production
      `buildServer()` from `@tainnel/hub` on an ephemeral port. Mock-hub
      stays in `packages/sdk/src/_test/` for SDK unit tests.
- [x] **`buildClient(h, party, opts)`** generic helper in harness;
      `buildAliceClient` becomes a thin wrapper. New `bob` party plumbed
      through harness (funded with ETH + USDC, max-approve to channel).
- [x] **Scenario**: alice + bob both connect to real hub. Alice opens
      100 USDC channel, bob opens 0/10 USDC (hub-funded) channel, bob
      issues invoice for 5 USDC, alice pays via `client.pay({ invoice })`
      → hub routes HTLC → bob settles → preimage round-trips → both
      channel states advance → invoice marked consumed.
- Gotcha addressed: the SDK's `pay()` and the hub's `Router` compute
  fees on different bases (alice adds fee on top of invoice; hub
  deducts from incoming). For Phase 2B we set both to zero fees in the
  test harness via `HUB_FEE_BPS=0`. Production fee-policy alignment is a
  separate concern, tracked but not blocking.

### 2C — Dispute + watchtower penalty ✅
- [x] **Watchtower watcher** (`apps/watchtower/src/watcher.ts`) —
      replaces stub. Uses viem `watchContractEvent` to subscribe to
      `ChannelClosingUnilateral(channelId, postedVersion,
      disputeDeadline)`. Configurable polling interval for tests.
- [x] **Watchtower responder** (`apps/watchtower/src/responder.ts`) —
      replaces stub. Calls `submitPenaltyProof(channelId,
      encodedNewerState, sigCloser)` via viem walletClient. Per D2.1,
      `submitPenaltyProof` (not `dispute`) is the path that triggers
      the 100% slash on `finalize`.
- [x] **Watchtower wiring** (`apps/watchtower/src/index.ts`) — exports
      `startWatchtower(opts)` returning `{ detector, responder, remember,
      stop }`. On `ChannelClosingUnilateral`, looks up our latest known
      state, evaluates fraud, reads `channels(channelId).closer` to
      determine closer side, calls responder.
- [x] **`@tainnel/sdk` dep** added to watchtower so it can reuse
      `encodeChannelStateForOnChain` and `signatureToHex`.
- [x] **`FraudDetector.getLatest(channelId)`** — exposes plaintext
      state for the responder.
- [x] **Scenario**: alice opens 100 USDC channel; runs 5 `payDirect`
      ops (versions 2..6); watchtower remembers all states; hub
      fraudulently posts v3 via `closeUnilateral`; watchtower's
      auto-subscription detects within 100ms and calls
      `submitPenaltyProof(v6, hub_sig)`; on-chain `postedVersion=6,
      penalized=true`; time-warp 24h+1s; `finalize()` pays alice the
      entire pot (100 USDC), exercises 100% slash path.
- [x] **Hub-side dispute-handler / chain-watcher** intentionally
      deferred: 2C scenario is satisfied by the watchtower alone.
      Defense-in-depth (warm-key hub responder) is a follow-up.

### 2D — Durability + recovery scenarios 🟡 partial
- [x] **Hot-key rotation scenario** — alice opens, payDirects, closes;
      generates a fresh key (`fundAndApproveParty(newKey)` provisions
      ETH+USDC+approval); opens a new channel signing with the new key;
      pays + closes; on-chain `channels(channelId).userA` reflects the
      new address. Demonstrates the existing CLI key-init primitives
      compose correctly through the SDK and contract.
- [x] **`E2EHandle.fundAndApproveParty(privateKey, usdcAmount?)`** —
      harness helper that funds a new EOA with ETH (via deployer
      transfer), mints USDC (MockERC20.mint is permissionless), and
      max-approves the PaymentChannel. Vanilla mode only; fork mode
      throws (USDC mint requires whale impersonation).
- [ ] **Hub-down recovery** — deferred to a separate PR. Gates on
      durable channel pool persistence (SQLite schema + hydration on
      restart). The SDK's WebSocketTransport already supports
      auto-reconnect with backoff and `onReconnect` hook; pairing it
      with hub durability is the missing half.
- [ ] **Receiver offline → resume** — deferred. Gates on CLI journal
      replay (scan local storage on `tainnel listen` startup, settle
      in-flight HTLCs from invoice store, time-out expired ones).
      Significant new code in `apps/cli/src/cmd/listen.ts`.
- [ ] **Stale-state invariant in CI** — deferred. Forge invariant test
      already exists in `packages/contracts/test/PaymentChannel.invariant.t.sol`;
      this task is a CI fuzz-runs bump for nightly runs.

---

Each Phase 2 scenario below has a status (✅ done / 🔵 deferred). Gating
components are noted for the deferred ones.

### Scenario: agent-pay-agent (open → pay → cooperative close, 3-party HTLC) ✅ (Phase 2B done)
- [x] `[agent]` SDK-driven (no CLI processes — that's deferred). Alice +
      bob each have a `ChannelClient` connected to the real hub.
- [x] `[agent]` Alice opens 100 USDC channel; bob opens 0/10 USDC channel
      (hub-funded counterparty deposit).
- [x] `[agent]` Bob creates invoice for 5 USDC. Alice pays via
      `client.pay({ invoice })`. Hub routes HTLC → bob settles → both
      states advance, preimage round-trips, invoice marked consumed.
- [ ] `[agent]` (deferred to 2D) Replace SDK calls with `tainnel pay` /
      `tainnel listen` CLI processes for full end-to-end coverage.

### Scenario: receiver offline then resume
**Gates on:** journal replay in `apps/cli` listen, hub durable channel
hydration.
- [ ] `[agent]` Mid-payment, kill Bob's listen process. Restart it. Confirm it
      reads the journal, reconnects, picks up the in-flight HTLC, reveals the
      preimage, both sides settle. No double-spend, no lost preimage.

### Scenario: signer hot-key rotation ✅ (Phase 2D done)
- [x] `[agent]` Alice opens channel with key1, runs `payDirect`, closes.
      Test generates a new private key; harness's
      `fundAndApproveParty(newKey)` funds + mints + approves. Alice
      opens a fresh channel signing with key2; on-chain
      `channels(channelId).userA` is the new address. Pays + closes
      successfully.

### Scenario: dispute → finalize (watchtower wins) ✅ (Phase 2C done)
- [x] `[agent]` Alice and hub do 5 `payDirect` ops (versions 2..6).
      Watchtower remembers all states. Hub posts old v3 via
      `closeUnilateral`. Watchtower auto-detects via viem
      `watchContractEvent`, calls `submitPenaltyProof(v6,
      hub_sig)`. Time-warp 24h+1s. `finalize` pays alice 100% of pot
      (penalized=true).

### Scenario: hub-down recovery
**Gates on:** SDK reconnect logic, hub state hydration.
- [ ] `[agent]` Mid-payment, kill the hub process. Restart it. Verify the SDK
      reconnects, replays state, in-flight HTLC resolves correctly.

### Scenario: replay attack ✅ (Phase 2A done)
- [x] `[agent]` **Variant A**: open → payDirect → unilateral close v2 →
      attempt `dispute` with same v2 + closer's sig → contract reverts
      `stale` (`s.version > ch.postedVersion` fails).
- [x] `[agent]` **Variant B**: open → payDirect → cooperative close v3 →
      attempt `closeUnilateral` with the older v2 state → contract reverts
      `!open` (`ch.status == Status.Open` fails).

### Scenario: stale-state invariant
- [ ] `[agent]` `forge invariant` test: across any random sequence of
      open/payment/close/dispute, total channel balance is conserved and the
      latest accepted state's version is monotonically non-decreasing.

---

## Internal security review checklist

This is where you sit down with coffee and read code. Every box is `[review]` —
you do this yourself, even if an agent has linted/scanned everything first.

### Contracts
- [ ] `[review]` Read `PaymentChannel.sol` line by line. Pay attention to:
      - integer overflow on `amountA + amountB` (≤ 2^256, but check)
      - reentrancy on token transfers (every `transfer`/`transferFrom` should
        be the last external call in a function, or guarded)
      - `block.timestamp` manipulation tolerance (we accept ±15s drift)
      - access control on `dispute` and `submitPenaltyProof` (anyone can submit;
        verify this is the intended model)
- [ ] `[review]` Read `Adjudicator.sol`. Confirm signature verification covers
      the typed-data domain so a sig from a different contract address fails.
- [ ] `[review]` Run `forge inspect` and check storage layout — no slot
      collisions.
- [ ] `[review]` Optional: run `slither .` and triage findings.

### State machine
- [ ] `[review]` Read `state-machine/src/channel.ts`, `htlc.ts`, `signing.ts`.
      Confirm the `htlcsRoot` algorithm matches the contract byte-for-byte
      (the oracle-fixture test from P3 already verifies this; you re-read for
      sanity).

### Hub
- [ ] `[review]` Read `router.ts`. Pay special attention to expiry-buffer math:
      the upstream HTLC expiry must be **strictly greater** than the downstream
      HTLC expiry by at least `EXPIRY_BUFFER_SECONDS`, and the buffer must be
      large enough to cover one mainnet inclusion delay.
- [ ] `[review]` Read `dispute-handler.ts`. Confirm:
      - we always submit our latest known state, not the disputed one
      - we don't gas-bump indefinitely (cap retries)
      - we log loudly if our state is older than the disputed state

### Watchtower
- [ ] `[review]` Read `responder.ts`. Same dispute logic as the hub but cold-
      key: confirm we don't try to sign a state we haven't observed.

### SDK
- [ ] `[review]` Read `client.ts.pay()` and `client.ts.payDirect()` (Phase 1
      addition). Confirm persist-before-send (D4.3) is not just a comment.
- [ ] `[review]` Read `signer.ts` (the interface) and confirm the v1 hot-key-file
      backend (in `apps/cli`) is the only one wired into the dogfood release.

### Agent runtime (CLI)
- [ ] `[review]` Read `apps/cli/src/cmd/listen.ts`. The signed-first / persist-first
      / ack-to-hub ordering is the single most safety-critical line in the agent
      runtime. A wrong order can leave us with a signed state in the wild that we do
      not have on disk.
- [ ] `[review]` Read `apps/cli/src/signer/hot-key-file.ts`. Confirm: scrypt params
      meet the spec, file permissions are 0600, wrong-passphrase paths return a
      typed error rather than a malformed key, and the raw private key is wiped from
      memory after signing.

## Correctness fuzzing
- [ ] `[agent]` `forge test --fuzz-runs 1000000` for the contract invariant
      tests. Run overnight. This is a correctness gate for funds safety, not a
      speed/scale target.

## CI gates
- [x] `[agent]` (Phase 1) Add an `e2e` job to `.github/workflows/ci.yml` that
      runs the vanilla-anvil 2-party scenario on every PR.
- [ ] `[agent]` (Phase 2) Extend the `e2e` job to run the full scenario suite
      once each scenario lands. Block merging if any scenario fails or coverage
      drops below thresholds.

## Done when

- All Phase 1 + Phase 2 scenarios pass
- 1M-run forge fuzz green
- All `[review]` checkboxes have been physically clicked by you
- A 24h soak on a Taiko mainnet fork against the deployed contracts behaves cleanly
- Branch merged with `feat(e2e): full lifecycle scenarios + internal audit`
