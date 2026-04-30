# P8 — E2E + internal audit

**Status:** 🔵 not started — `e2e/src/scenarios.test.ts` has 4 placeholders, all
real scenarios `describe.skip`'d
**Blocks:** P9, P10
**Effort:** Phase 1 ~5–9h (single 2-party scenario green in CI). Phase 2 ~1 week
(remaining scenarios + audit).

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

### D8.3 Phase 1 chain target
- **Vanilla anvil** (chainId 31337), no Taiko fork. Phase 2 may move to a
  Taiko-mainnet-fork harness for fee/precompile parity, but Phase 1 deliberately
  removes that dependency to keep the test hermetic and fast.
- USDC: deploy our own `MockERC20` ("USDC", 6 decimals) on each test boot.
- Decision: ☑ vanilla anvil + own MockUSDC ☐ Taiko mainnet fork ☐ Taiko Hoodi testnet

---

## Phase 1 — alice → hub 2-party cooperative close

The smallest end-to-end slice that exercises real contracts + real SDK + a
minimal real hub: Alice opens a channel with the hub, sends one direct
(non-HTLC) balance update granting the hub 5 USDC, and cooperatively closes.

### Test harness — `e2e/src/harness.ts`

- [ ] `[agent]` Spin up vanilla anvil (no fork) via the existing
      `startAnvilFork({ chainId: 31337 })` from `@tainnel/test-utils`.
- [ ] `[agent]` Deploy `packages/contracts/test/mocks/MockERC20.sol` as USDC
      (6 decimals). Mint 100 USDC to Alice and 100 USDC to Hub from
      `TEST_KEYS`.
- [ ] `[agent]` Deploy `Adjudicator` + `PaymentChannel` proxies and call
      `setTokenAllowed(usdc, true)`. Either invoke `script/Deploy.s.sol` via
      `forge script` (`USDC_ADDRESS=<MockERC20>`) or do an inline viem deploy
      that mirrors it — pick whichever is cleaner during implementation.
- [ ] `[agent]` Start a minimal in-process WebSocket hub (see below). Bind to
      an ephemeral port.
- [ ] `[agent]` Return a single `E2EHandle { rpcUrl, chainId, usdc,
      paymentChannel, adjudicator, alice, hub, hubServer, stop() }`. `stop()`
      tears down anvil and the hub.

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

- [ ] `[agent]` Add `ChannelClient.payDirect(channelId, { amount })` that:
      bumps the channel's `version`, recomputes `balanceA`/`balanceB`, keeps
      `htlcsRoot = bytes32(0)`, signs, persists before send (D4.3), sends to
      hub, awaits hub counter-sig, stores both signatures.
- [ ] `[agent]` Reuse existing state-machine helpers; the new method is a thin
      wrapper that bypasses the HTLC builder.

### The test — `e2e/src/scenarios.test.ts`

- [ ] `[agent]` Replace the `expect(true)` placeholder with a single
      `describe('e2e — alice→hub 2-party cooperative close', ...)` block.
- [ ] `[agent]` `beforeAll` calls `bootE2E()` (60s timeout). `afterAll` calls
      `h.stop()`.
- [ ] `[agent]` Test body, using SDK only (no CLI in Phase 1):
      1. Build `ChannelClient` for Alice with `localSigner(ALICE_PK)`,
         `WebSocketTransport({ url: hubServer.url })`,
         `InMemoryStorage()`, and the chain adapter pointed at
         `paymentChannel`.
      2. `await alice.transport.connect()`
      3. `const ch = await alice.open({ counterparty: hub.address, token: usdc, amountA: 100_000_000n, amountB: 0n })`
         → asserts on-chain `channels(ch.id).status == Open`.
      4. `await alice.payDirect(ch.id, { amount: 5_000_000n })` (5 USDC)
      5. `await alice.close(ch.id, { cooperative: true })`
      6. Assert on-chain: `usdc.balanceOf(alice) == 95_000_000n`,
         `usdc.balanceOf(hub) == 5_000_000n`,
         `paymentChannel.channels(ch.id).status == Closed`.
- [ ] `[agent]` Keep all multi-party / dispute / HTLC scenarios as
      `describe.skip` so they show in the report but don't run.

### CI gate

- [ ] `[agent]` Add an `e2e` job to `.github/workflows/ci.yml` that runs
      `pnpm -F @tainnel/e2e test`. Block merge on failure.

### Phase 1 done when

- `pnpm -F @tainnel/e2e test` reports 1 passed, 0 failed, deferred scenarios
  skipped, runtime < 30s.
- CI runs the e2e job on every PR.
- Existing forge / TS unit tests still pass.

---

## Phase 2 — full lifecycle scenarios (deferred)

Each scenario below reuses the Phase 1 harness (swap the test-only hub for the
real `apps/hub` once it's ready). Status of all of these is **🔵 deferred until
the underlying primitives land** — the gating components are noted per
scenario.

### Scenario: agent-pay-agent (open → pay → cooperative close, 3-party HTLC)
**Gates on:** `apps/hub` router with HTLC forwarding; `apps/cli` `tainnel pay` /
`tainnel listen` end-to-end.
- [ ] `[agent]` Spawn two CLI processes from `apps/cli`. Alice runs from a key
      file; Bob runs `tainnel listen --hub <hub-url>`.
- [ ] `[agent]` Alice opens a 100 USDC channel with the hub. Bob opens a 10
      USDC channel with the same hub.
- [ ] `[agent]` Alice runs `tainnel pay --to <bob> --amount 5 --json`. Bob's
      listen process accepts the inbound HTLC, reveals the preimage, both
      channel states advance.
- [ ] `[agent]` Alice cooperatively closes via `tainnel channel close <id>
      --cooperative`. Final balances on-chain match expectation.

### Scenario: receiver offline then resume
**Gates on:** journal replay in `apps/cli` listen, hub durable channel
hydration.
- [ ] `[agent]` Mid-payment, kill Bob's listen process. Restart it. Confirm it
      reads the journal, reconnects, picks up the in-flight HTLC, reveals the
      preimage, both sides settle. No double-spend, no lost preimage.

### Scenario: signer hot-key rotation
**Gates on:** `tainnel keys init` flow.
- [ ] `[agent]` Alice generates a new key with `tainnel keys init --out
      new.enc`. Cooperative-close existing channel. Re-open signing with the
      new key. Pay Bob through the new channel. On-chain `ChannelOpened` shows
      the new address.

### Scenario: unilateral close → finalize (no dispute)
**Gates on:** SDK `closeUnilateral`, time-warp helper.
- [ ] `[agent]` Alice opens, sends 1 payment. Hub goes silent. Alice calls
      `closeUnilateral` with the latest signed state. Time-warp past the
      dispute window. `finalize` distributes funds correctly.

### Scenario: dispute → finalize (watchtower wins)
**Gates on:** `apps/watchtower` chain watcher + responder, hub
`dispute-handler`.
- [ ] `[agent]` Alice and hub do 5 payments (versions 1–5). Hub posts an old
      state (v3) via `closeUnilateral`. Watchtower (running with Alice's signed
      states up to v5) detects and submits `dispute` with v5. Time-warp past
      the window. `finalize` pays Alice the full penalty (per D2.1, 100%
      slash).

### Scenario: hub-down recovery
**Gates on:** SDK reconnect logic, hub state hydration.
- [ ] `[agent]` Mid-payment, kill the hub process. Restart it. Verify the SDK
      reconnects, replays state, in-flight HTLC resolves correctly.

### Scenario: replay attack
- [ ] `[agent]` Capture a signed state from earlier in the channel. Submit it
      after a newer state is on-chain. Assert the contract rejects.

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
