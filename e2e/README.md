# @tainnel/e2e

Cross-package end-to-end tests. Each scenario:

1. Spins up `anvil` (vanilla, or as a Taiko mainnet fork when `forkUrl` is set).
2. Deploys contracts via `forge script` (vanilla mode) or uses already-deployed
   addresses from `CONTRACT_ADDRESSES[TAIKO_MAINNET_CHAIN_ID]` (fork mode).
3. Starts an in-process `@tainnel/hub` and `@tainnel/watchtower`.
4. Drives the SDK through realistic flows.

## Active scenarios (`scenarios.test.ts`)

Vanilla anvil. Full lifecycle is exercised, including:

- channel open, pay, cooperative close,
- HTLC routing,
- watchtower stale-state penalty,
- key rotation,
- hub-down recovery.

Run with `pnpm -F @tainnel/e2e test`.

## Fork scenarios (`scenarios.fork.test.ts`)

Anvil forked from Taiko mainnet at a pinned block. The container `describe`
is skipped when `E2E_FORK_URL` is unset. Run with `pnpm -F @tainnel/e2e
test:fork` and an `E2E_FORK_URL=https://...` environment variable.

USDC provisioning on the fork uses `anvil_impersonateAccount` against the
account given by `E2E_USDC_WHALE` (any account holding ≥ ~300 USDC at the
fork block qualifies — Taiko USDC bridge proxy or a known CEX hot wallet).
The two value-flow tests (`it.skipIf(!HAS_WHALE)`) skip cleanly when
`E2E_USDC_WHALE` is unset; only the bytecode-parity boot is exercised in
that mode. See `harness.ts:fundAndApproveParty` and `whale.ts` for the
fork-mode funding path.

## CI

The vanilla suite runs on every PR. The fork suite is gated on the
`TAIKO_MAINNET_RPC_URL` repository secret and is required for release branches.
