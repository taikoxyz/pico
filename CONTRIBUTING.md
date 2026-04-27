# Contributing

Thanks for considering a contribution. tainnel is in active design — the bootstrap
exists, but the protocol is not finalized. Discussions about scope and tradeoffs are
welcome before any large change.

## Local setup

```bash
pnpm install
pnpm build
pnpm test
forge build --root packages/contracts
```

## Coding standards

- TypeScript strict mode. No `any` without a one-line justification comment.
- No default exports for libraries. Named exports only.
- Pure functions where possible; isolate I/O at the edges.
- Module budget: < 400 lines per file.
- All amounts as `bigint`. USDC has 6 decimals on Taiko, ETH has 18. Never mix in
  `number`.
- Times are milliseconds as `number`; on-chain timestamps are `bigint`.
- No `console.log` in committed code. Use `pino` (or pass a logger).
- Errors: typed error classes. Never throw a string.
- Tests for every public function in `packages/state-machine` and `packages/protocol`.
- Hub and watchtower must hold ≥ 70% line coverage.

## Commit format

Conventional commits, lowercase prefix:

```
feat(sdk): add channel close orchestration
fix(hub): correct dispute window math at midnight
chore: bump biome to 1.10
```

`lefthook` enforces this in `commit-msg`.

## PR process

1. Branch from `main`.
2. Open a PR with a description of the user-visible change and trade-offs considered.
3. CI must be green.
4. At least one reviewer approval.

## Changesets

Every PR that touches a publishable package under `packages/*` should include a
changeset:

```bash
pnpm changeset
```

Changesets describe the user-facing impact, not the implementation.
