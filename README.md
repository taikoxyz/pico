# tainnel

> Trustless **1-hop state channel network for micro-payments on Taiko L2**.
> v1 is an **AI-agent payments system**: the agent surface is the
> [`tainnel` CLI](./apps/cli/), not a browser wallet.

Inspired by Lightning's LSP model. Stablecoin (USDC) first in v1. **No native token.
No governance. No bridges. No MCP / x402 association.**

> **New here?** Open [`docs/learning/index.html`](./docs/learning/index.html) for a tour of every
> component before diving into source code. Start with `00-big-picture.html` if you
> want intuition first.

## Why 1-hop

Lightning's full multi-hop topology is overkill for the workloads tainnel targets:

- AI agents paying agents
- Clients paying DVMs
- Streaming dust-sized payments to APIs

Multi-hop adds liquidity-routing complexity, locked HTLCs, and onion-routing overhead
without buying the marginal user anything when "1 hop through a hub" is plenty. tainnel
collapses the graph: every channel terminates at a hub, every payment is `client → hub →
recipient`. Hubs compete on liquidity, fees, and uptime — exactly like LSPs.

## Repository layout

```
apps/
  cli/          tainnel <cmd> CLI — the v1 agent runtime (pay, listen, channel ops)
  hub/          Long-running hub service (Fastify + ws + sqlite/postgres)
  watchtower/   Standalone fraud monitor that posts penalty txs
packages/
  contracts/    Solidity 0.8.26 PaymentChannel + Adjudicator + HTLC (Foundry)
  protocol/     Shared TS types, EIP-712 schemas, constants, Nostr event kinds
  state-machine/ Pure-function channel state transitions (browser-safe)
  sdk/          Client SDK with Signer interface (browser + Node, depends on viem)
  dvm-adapter/  Nostr DVM payment helpers (Phase 2)
  test-utils/   Anvil/forge fixtures, mock hubs, deterministic keys
e2e/            Cross-package end-to-end tests
docs/           Protocol spec, threat model, and per-phase plans
docs/learning/  Per-component HTML tutorials — start at docs/learning/index.html
```

## Quick start

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm tainnel hello              # smoke check; prints all package versions
forge build --root packages/contracts
```

## Quick start for an AI agent (v1 target)

```bash
pnpm install
pnpm tainnel keys init                                   # encrypted hot key
pnpm tainnel channel open --hub https://hub.example --amount 25
pnpm tainnel pay --to 0xRecipient --amount 0.05 --json   # one-shot payment
pnpm tainnel listen --hub https://hub.example &          # receive payments
```

Any-language agents shell out to the CLI; non-TS callers parse the `--json` output.

## Toolchain

| Concern             | Tool                              |
|---------------------|-----------------------------------|
| Package manager     | pnpm 9.x with workspaces          |
| Monorepo runner     | Turborepo 2.x                     |
| TypeScript          | 5.5+ (strict, ES2022, bundler)    |
| Solidity            | Foundry, solc 0.8.26              |
| EVM client          | viem 2.x                          |
| Tests (TS)          | Vitest                            |
| Tests (Solidity)    | forge test                        |
| Lint + format       | Biome 1.x                         |
| Versioning          | Changesets                        |
| Git hooks           | lefthook                          |
| CI                  | GitHub Actions                    |

## Hard constraints

- No native token. No governance. No staking.
- No bridges. No wrapped assets.
- viem only — never ethers.
- pnpm only — never yarn or npm.
- Local Prometheus + structured logs only — no observability vendors.

## Status

Pre-GA staging. AI-audited (DeepSeek, see `deepseek_audit_report_*.md`),
critical and high findings addressed in code. Multi-agent re-audit, multisig
ownership transfer, and mainnet smoke channel still pending. Mainnet config
gates fail-fast on dev keys and unsigned envelopes
(`apps/{hub,watchtower}/src/config-validate.ts`); state-acceptance gates
(`packages/state-machine/src/admit.ts`) verify hub-supplied states before
the SDK persists them.

Production-readiness work is tracked on GitHub. See the master tracker
[issue #21](https://github.com/dantaik/tainnel/issues/21) for the full
sub-issue checklist and
[`docs/audit-status.md`](./docs/audit-status.md) for the per-finding
reconciliation.

## Documentation

- [Issue #21](https://github.com/dantaik/tainnel/issues/21) — master
  production-readiness tracker. **Start here if you want to know what's
  left.** Sub-issues are categorized (`code` / `test` / `gke` /
  `taiko-contract` / `docs` / `audit` / `ci`) and prioritized
  (`high` / `medium` / `low`).
- [`docs/audit-status.md`](./docs/audit-status.md) — per-finding audit
  reconciliation against current code.
- [`docs/learning/index.html`](./docs/learning/index.html) — per-component
  HTML tutorials, offline-readable.
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — components, trust assumptions,
  why 1-hop.
- [`docs/protocol-spec.md`](./docs/protocol-spec.md) — formal protocol spec.
- [`docs/threat-model.md`](./docs/threat-model.md) — adversaries and failure
  modes.
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — coding standards & PR process.
- [`SECURITY.md`](./SECURITY.md) — disclosure policy.

## License

MIT — see [`LICENSE`](./LICENSE).
