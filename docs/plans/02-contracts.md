# P2 — Contracts

**Status:** 🔵 not started (stubs revert with `"not implemented"`)
**Blocks:** P5, P6, P8, P10
**Effort:** 1–2 weeks; longest single sub-project after the hub
**Parallelizable with:** P3 (state machine) once P1 is locked

## Surface

- `packages/contracts/src/PaymentChannel.sol` — pairwise channel core
- `packages/contracts/src/Adjudicator.sol` — EIP-712 verification for signed states
- `packages/contracts/src/HTLC.sol` — library: `hashLock`, `verifyPreimage`, `rootOf`
- `packages/contracts/src/interfaces/{IPaymentChannel,IWatchtower}.sol` — already
  stable from P1, do not change

## Decisions

### D2.1 Penalty share when watchtower successfully challenges
- **Default:** 100% slash (the cheating party loses their full balance to the honest
  party). This is the standard Lightning revocable-state penalty and is required for
  game-theoretic safety.
- **Tradeoff:** anything < 100% creates a positive-EV griefing strategy.
- Decision: ☐ 100% ☐ 50% (not recommended)

### D2.2 Reentrancy guard
- **Default:** OpenZeppelin `ReentrancyGuard` on all external state-mutating
  functions that move tokens
- **Tradeoff:** OZ is well-audited, costs ~2.4k gas per call. Custom transient-storage
  guards are cheaper but unproven on Taiko.
- Decision: ☐ OZ `ReentrancyGuard` ☐ custom

### D2.3 ETH support in v1
- **Default:** **no** — USDC only. The channel's `token` field exists but
  `address(0)` paths are explicitly disabled.
- **Tradeoff:** ETH support means handling `payable`, gas accounting, and reentrancy
  through `call`. Skipping it for v1 cuts ~30% of the contract test surface.
- **Why it matters now:** locking this lets `openChannel` revert on
  `token == address(0)` cleanly.
- Decision: ☐ USDC only ☐ also ETH (defer to phase 2)

### D2.4 Upgradability
- **Default:** **none**. Contracts are immutable. If you ship a v2, deploy fresh
  contracts and migrate via the SDK.
- **Tradeoff:** upgradable contracts are a larger attack surface and complicate
  audit. The dogfood scope is small enough that throwing away v1 contracts is
  acceptable.
- Decision: ☐ immutable ☐ UUPS proxy

### D2.5 ERC-20 quirks (USDC on Taiko specifically)
- **Default:** use `safeTransfer` / `safeTransferFrom` from OZ `SafeERC20` to handle
  any non-standard return semantics. Confirm Taiko USDC's address (bridged USDC.e
  vs native — record in `packages/protocol/src/constants.ts` once known).

## Implementation tasks

### Adjudicator
- [ ] `[agent]` Implement `recoverStateSigner` using viem-compatible EIP-712 hashing
      (must produce identical digests to the off-chain signer in
      `@tainnel/state-machine`).
      **Acceptance:** a forge test signs a state with a known private key off-chain
      (using ffi or hardcoded fixture), passes signature into the contract, recovers
      same address.
- [ ] `[agent]` Implement `verifyDualSig(userA, userB, stateEncoded, sigA, sigB)`.
      **Acceptance:** returns true iff both sigs valid and from expected addresses.
- [ ] `[agent]` Compute domain separator via OZ `EIP712` upgradable base — use
      its `_hashTypedDataV4` so we never hand-roll typed-data hashing.

### HTLC library
- [ ] `[agent]` Implement `HTLC.hashLock(Lock memory)` returning the same 32-byte
      hash as `@tainnel/state-machine.hashHtlc()`.
- [ ] `[agent]` Implement `HTLC.verifyPreimage(bytes32 paymentHash, bytes preimage)`
      using the hash function picked in D1.2.
- [ ] `[agent]` Implement `HTLC.rootOf(Lock[] memory)` matching the algorithm in D1.3.
- [ ] `[agent]` Solidity-side fuzz: 10k runs against a TS oracle that produces the
      same root.

### PaymentChannel — implementation
- [ ] `[agent]` `openChannel(userB, token, amountA, amountB) returns (channelId)`
      - assert `token == USDC` (or in allowlist), `amountA + amountB ≥ MIN`
      - generate deterministic `channelId = keccak256(abi.encode(userA, userB, token, openedAt, nonce))`
      - `safeTransferFrom` from `userA` and `userB`
      - emit `ChannelOpened`
- [ ] `[agent]` `closeCooperative(channelId, finalState, sigA, sigB)`
      - require `Adjudicator.verifyDualSig`
      - distribute balances per `finalState`
      - mark closed
- [ ] `[agent]` `closeUnilateral(channelId, state, sigCounterparty)`
      - require sender is one of the channel parties
      - verify counterparty's signature
      - record `(postedVersion, deadline = block.timestamp + DISPUTE_WINDOW)`
      - emit `ChannelClosingUnilateral`
- [ ] `[agent]` `dispute(channelId, state, sigCounterparty)`
      - require `state.version > postedVersion`
      - verify signature
      - replace posted state, **do not extend** the deadline
      - emit `DisputeRaised`
- [ ] `[agent]` `submitPenaltyProof(channelId, penaltyState, signature)` — watchtower
      path. Same shape as `dispute` but credentialled to a registered watchtower
      address (or any address; both are valid designs — pick "any address" for v1).
- [ ] `[agent]` `finalize(channelId)`
      - require `block.timestamp ≥ deadline`
      - distribute balances per the latest accepted state
      - emit `ChannelFinalized`

### Tests
- [ ] `[agent]` Unit tests: every public function, happy path + every revert path
- [ ] `[agent]` Fuzz: `openChannel` with arbitrary amounts; `closeCooperative` with
      arbitrary signed states; `dispute` race conditions
- [ ] `[agent]` Invariant: total channel balance is conserved across any sequence of
      open/close/dispute calls. Run with `--fuzz-runs 100000` in CI.
- [ ] `[agent]` Replay test: stale state submission is always rejected after a newer
      one has been accepted.
- [ ] `[review]` You read `PaymentChannel.sol` and `Adjudicator.sol` line by line.

### Deploy

> Pre-reqs (your responsibility): `TAIKO_HOODI_RPC_URL`, `DEPLOYER_PRIVATE_KEY`
> (funded with ≥ 0.05 ETH on Hoodi), `TAIKOSCAN_API_KEY`. Store in
> `packages/contracts/.env` (gitignored).

- [ ] `[human]` Deploy to Taiko Hoodi:
      ```bash
      cd packages/contracts
      forge script script/Deploy.s.sol --rpc-url taiko_hoodi --broadcast --verify
      ```
- [ ] `[human]` Verify on Taikoscan: confirm both contracts show source code.
- [ ] `[agent]` Update `packages/protocol/src/constants.ts` with deployed addresses
      under `CONTRACT_ADDRESSES[TAIKO_HOODI_CHAIN_ID]`.
- [ ] `[human]` Open one test channel between two anvil-funded keys via cast or a
      forge script. Confirm `ChannelOpened` event in Taikoscan.
- [ ] **Mainnet deploy is in P10, not here.** Do not deploy to mainnet until P8
      audit gates are green.

## Done when

- All `[ ]` boxes above checked
- `forge test --fuzz-runs 100000` green
- `forge coverage` ≥ 95% on `src/PaymentChannel.sol`, `src/Adjudicator.sol`,
  `src/HTLC.sol`
- Hoodi addresses recorded and verified
- Branch merged to main with commit `feat(contracts): implement v1 channel + adjudicator`
