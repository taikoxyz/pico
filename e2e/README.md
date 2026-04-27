# @tainnel/e2e

Cross-package end-to-end tests. Each scenario:

1. Spins up `anvil` with a Taiko fork.
2. Deploys contracts via `forge script`.
3. Starts an in-process `@tainnel/hub` and `@tainnel/watchtower`.
4. Drives the SDK through realistic flows.

Active scenarios in the bootstrap are smoke-only (`scenarios.test.ts`); the full
open → pay → close, dispute, and hub-down-recovery cases are `describe.skip`'d until the
underlying primitives land.
