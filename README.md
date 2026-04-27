# tainnel

> Trustless **1-hop state channel network for micro-payments on Taiko L2**.

Inspired by Lightning's LSP model and optimized for AI service markets and Nostr Data
Vending Machine (DVM) payment flows. Stablecoin (USDC) and ETH first-class. **No native
token. No governance. No bridges.**

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
  hub/          Long-running hub service (Fastify + ws + sqlite/postgres)
  watchtower/   Standalone fraud monitor that posts penalty txs
  wallet-ui/    Reference web wallet (React + Vite + wagmi v2 + tailwind)
  cli/          tainnel <cmd> CLI for ops & development
packages/
  contracts/    Solidity 0.8.26 PaymentChannel + Adjudicator + HTLC (Foundry)
  protocol/     Shared TS types, EIP-712 schemas, constants, Nostr event kinds
  state-machine/ Pure-function channel state transitions (browser-safe)
  sdk/          Client SDK (browser + Node, depends on viem)
  dvm-adapter/  Nostr DVM payment integration helpers
  test-utils/   Anvil/forge fixtures, mock hubs, deterministic keys
e2e/            Cross-package end-to-end tests
docs/           Protocol spec & threat model
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

## Documentation

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — components, trust assumptions, why 1-hop.
- [`docs/protocol-spec.md`](./docs/protocol-spec.md) — formal protocol spec.
- [`docs/threat-model.md`](./docs/threat-model.md) — adversaries and failure modes.
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — coding standards & PR process.
- [`SECURITY.md`](./SECURITY.md) — disclosure policy.

## License

MIT — see [`LICENSE`](./LICENSE).
