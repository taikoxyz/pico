# P3 — State machine

**Status:** 🟢 done — `pnpm --filter @pico/state-machine test` passes after
workspace packages are built.
`validateUpdate` / `applyUpdate` / `computeBalance`, HTLC transitions, typed-data
hashing/signature verification, HTLC root calculation, invoice helpers, and the
cross-package oracle fixture are implemented and tested.
**Blocks:** —
**Effort:** ~1 week
**Parallelizable with:** P2 (contracts) follow-ups once P1 is locked

## Why this is the safest sub-project to fully agent-drive

Pure functions, deterministic inputs, no I/O, no chain. The acceptance criterion is a
test suite — if the suite is property-based and high-coverage, you can hand it to an
agent and barely re-read the diff. **The only `[review]` gate is the test suite
itself, plus the `oracle.json` round-trip test.**

## Decisions

> All decisions in this phase were settled in P1. If P1 is not yet locked, stop.

## Implementation record

The state-machine implementation now includes:

- Pure state transitions in `channel.ts`, `htlc.ts`, `replay.ts`, and `preimage.ts`.
- EIP-712 typed-data builders, digest helpers, and signature verification helpers in
  `signing.ts`.
- HTLC root calculation delegated to the shared protocol implementation, matching the
  Solidity `HTLC.rootOf` sorted-keccak Merkle algorithm.
- Invoice helper coverage and preimage verification.
- `packages/state-machine/test/fixtures/oracle.json`, consumed by both TypeScript and
  forge tests to keep off-chain and on-chain hashing byte-equivalent.
- Test coverage across 88 state-machine tests, plus forge oracle tests in P2.

There are no remaining P3-specific blockers for the controlled mainnet real-money E2E
test. Remaining readiness work is tracked in P5/P6/P8/P9/P10.

## Used by downstream phases

These callers consume the completed `state-machine` exports:

- **P4 SDK** — uses the `hash*` and `verify*` helpers from `signing.ts` to build the
  `Signer` interface contract and the `pay()` / `close()` flows.
- **P5 Hub** — the `router.ts` expiry math relies on `applyUpdate` invariants and
  `htlcsRoot` byte-equivalence with the contract.
- **P6 Watchtower** — `responder.ts` needs `verifyChannelStateSignature` to check that
  a posted state's signature is genuine before submitting a counter-state.
- **P7 Agent runtime (CLI)** — the `pico listen` daemon validates inbound HTLCs
  with `validateUpdate` + `verifyHtlcSignature`.

## Done when

- `pnpm --filter @pico/state-machine test` passes.
- `pnpm --filter @pico/contracts test` passes the oracle round-trip tests.
- The roadmap marks P3 🟢 and does not list P3 as a blocker for mainnet E2E testing.
