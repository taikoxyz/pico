# P8 — E2E + internal audit

**Status:** 🔵 not started — `e2e/src/scenarios.test.ts` has 4 placeholders, 3
`describe.skip`'d
**Blocks:** P9, P10
**Effort:** ~1 week (split between writing scenarios and reading code)

## Why this exists as its own phase

P2–P7 each verify their own surface in isolation. P8 is the only place where
the **whole stack** is exercised: contracts + state machine + SDK + hub +
watchtower + agent runtime (CLI) all running together against an anvil fork of
Taiko. This is also where you, the human, sit down and read the most
safety-critical code top-to-bottom.

## Decisions

### D8.1 External audit before mainnet?
- **Default:** **no external audit** for the dogfood scope (you chose option C
  during brainstorming: dogfood / private with real money on Taiko mainnet,
  no whitelist, ~1–2 month horizon).
- If you change your mind later, this is the gate to add it before P10.
- Decision: ☐ no audit (dogfood path) ☐ ask one external reviewer ☐ paid audit

### D8.2 Bug bounty?
- **Default:** **no** for v1. Revisit if scope expands.
- Decision: ☐ no ☐ Immunefi ☐ self-managed page

## E2E scenarios (`e2e/src/scenarios.test.ts`)

### Test harness
- [ ] `[agent]` `e2e/src/harness.ts`: spin up anvil with a Taiko mainnet fork
      (block pinned), deploy contracts via `forge script`, start an in-process
      hub + watchtower, return handles to all of them. Stop them on `afterAll`.
- [ ] `[agent]` Deterministic key fixtures from `@tainnel/test-utils` (alice,
      bob, hub, watchtower).

### Scenario: agent-pay-agent (open → pay → cooperative close)
- [ ] `[agent]` Spawn two CLI processes from `apps/cli`. Alice runs from a key file;
      Bob runs `tainnel listen --hub <mock>`.
- [ ] `[agent]` Alice opens a 100 USDC channel with the hub via `tainnel channel
      open`. Bob opens a 10 USDC channel with the same hub.
- [ ] `[agent]` Alice runs `tainnel pay --to <bob> --amount 5 --json`. Bob's listen
      process accepts the inbound HTLC, reveals the preimage, both channel states
      advance.
- [ ] `[agent]` Alice cooperatively closes via `tainnel channel close <id>
      --cooperative`. Final balances on-chain match expectation.

### Scenario: receiver offline then resume
- [ ] `[agent]` Alice and Bob hold open channels. Bob's `tainnel listen` is up.
      Alice issues `tainnel pay`. **Mid-payment, kill Bob's listen process.**
- [ ] `[agent]` Restart `tainnel listen`. Confirm it reads the journal, reconnects
      to the hub, picks up the in-flight HTLC, reveals the preimage, and both
      sides settle. No double-spend, no lost preimage.

### Scenario: signer hot-key rotation
- [ ] `[agent]` Alice generates a new key with `tainnel keys init --out new.enc`.
- [ ] `[agent]` Cooperative-close the existing channel.
- [ ] `[agent]` Re-open a channel signing with the new key. Pay Bob through the
      new channel. Confirm the on-chain `ChannelOpened` shows the new address.

### Scenario: unilateral close → finalize (no dispute)
- [ ] `[agent]` Alice opens, sends 1 payment. Hub goes silent.
- [ ] `[agent]` Alice calls `closeUnilateral` with the latest signed state.
- [ ] `[agent]` Time-warp forward past the dispute window.
- [ ] `[agent]` `finalize` distributes funds correctly.

### Scenario: dispute → finalize (watchtower wins)
- [ ] `[agent]` Alice and hub do 5 payments (versions 1–5).
- [ ] `[agent]` **Hub posts an old state (version 3) via `closeUnilateral`** — a
      simulated fraud.
- [ ] `[agent]` Watchtower (running with Alice's signed states up to v5) detects
      and submits `dispute` with v5.
- [ ] `[agent]` Time-warp past the window. `finalize` pays Alice the full
      penalty (per D2.1, 100% slash).

### Scenario: hub-down recovery
- [ ] `[agent]` Mid-payment, kill the hub process. Restart it. Verify the SDK
      reconnects, replays state, and the in-flight HTLC resolves correctly.

### Scenario: replay attack
- [ ] `[agent]` Capture a signed state from earlier in the channel. Submit it
      after a newer state has been recorded. Assert the contract rejects.

### Scenario: stale-state invariant
- [ ] `[agent]` `forge invariant` test: across any random sequence of
      open/payment/close/dispute, total channel balance is conserved and the
      latest accepted state's version is monotonically non-decreasing.

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
- [ ] `[review]` Read `client.ts.pay()`. Confirm persist-before-send (D4.3) is
      not just a comment.
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
- [ ] `[agent]` Add an `e2e` job to `.github/workflows/ci.yml` that runs the
      anvil-based scenarios on every PR.
- [ ] `[agent]` Block merging if any scenario fails or coverage drops below
      thresholds.

## Done when

- All scenarios pass
- 1M-run forge fuzz green
- All `[review]` checkboxes have been physically clicked by you
- A 24h soak on a Taiko mainnet fork against the deployed contracts behaves cleanly
- Branch merged with `feat(e2e): full lifecycle scenarios + internal audit`
