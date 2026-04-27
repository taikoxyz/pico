# tainnel roadmap

> **Target:** dogfood / private launch on Taiko mainnet. USDC only, full 1-hop routing,
> one watchtower. ~1–2 months end-to-end. DVM and ETH support are Phase-2 follow-ups.

This roadmap is the bird's-eye view. Each phase has a detailed plan in
[`docs/plans/`](./docs/plans/). Work the phases in order unless explicitly marked
parallelizable.

---

## Tag conventions

| Tag        | Meaning                                                                 |
|------------|-------------------------------------------------------------------------|
| `[agent]`  | Pure typing/grunt work. Hand to a coding agent with the file as context. |
| `[human]`  | Needs your judgment, signature, or access. Decisions, deploys, key ops. |
| `[review]` | Agent did the work; you read the diff before merge.                      |

A `[human]` task may be *prepared* by an agent (e.g., draft a deploy script) but the
agent must stop before pressing the button.

---

## Status table

| #   | Phase                       | Style                | Status     | Blocked by | Detail                                                |
|-----|-----------------------------|----------------------|------------|------------|-------------------------------------------------------|
| P0  | Bootstrap monorepo          | mixed                | 🟢 done    | —          | merged in `chore: bootstrap monorepo skeleton`        |
| P1  | Protocol freeze             | `[human]` heavy      | 🔵 not started | P0     | [01-protocol-freeze.md](./docs/plans/01-protocol-freeze.md) |
| P2  | Contracts                   | `[agent]`+`[review]` | 🔵 not started | P1     | [02-contracts.md](./docs/plans/02-contracts.md)        |
| P3  | State machine               | `[agent]`            | 🟡 partial | P1         | [03-state-machine.md](./docs/plans/03-state-machine.md) |
| P4  | SDK                         | `[agent]`            | 🔵 not started | P3     | [04-sdk.md](./docs/plans/04-sdk.md)                    |
| P5  | Hub                         | `[agent]`+`[review]` | 🔵 not started | P3, P4 | [05-hub.md](./docs/plans/05-hub.md)                    |
| P6  | Watchtower                  | `[agent]`+`[review]` | 🔵 not started | P3     | [06-watchtower.md](./docs/plans/06-watchtower.md)      |
| P7  | Wallet UI                   | `[agent]`+`[review]` | 🔵 not started | P4     | [07-wallet-ui.md](./docs/plans/07-wallet-ui.md)        |
| P8  | E2E + internal audit        | mixed                | 🔵 not started | P5, P6, P7 | [08-e2e-and-audit.md](./docs/plans/08-e2e-and-audit.md) |
| P9  | Ops & infra                 | `[human]` heavy      | ⚪ planning | P8        | [09-ops.md](./docs/plans/09-ops.md)                    |
| P10 | Mainnet dogfood launch      | `[human]` heavy      | ⚪ planning | P9        | [10-launch.md](./docs/plans/10-launch.md)              |

🟢 done · 🟡 in progress / partial · 🔵 not started · ⚪ planning only

### Parallelism opportunities

- **P2 and P3 can run in parallel** once P1 freezes the wire format. Different agents.
- **P6 (watchtower) can run in parallel with P5 (hub)** — both depend on P3 only.
- **P7 (wallet UI)** can start once P4 is real enough to mock against.

---

## What to work on next

1. **P1 protocol freeze** is the only unblocked phase. Open [`docs/plans/01-protocol-freeze.md`](./docs/plans/01-protocol-freeze.md), work through the **decisions** section first (those are all `[human]`). Each decision has a default — accepting all defaults is fine for a dogfood launch.
2. Once P1 is locked in, dispatch one agent against P2 and a second agent against P3 in parallel.
3. Don't start P5/P6/P7 until P3 has at least the signing + HTLC root computation merged.

---

## Decisions still open

These are all `[human]` decisions surfaced from sub-plans, indexed here so you can
scan them in one place. Each has a default; accepting defaults across the board is the
"dogfood path".

| Phase | Decision | Default | Where |
|---|---|---|---|
| P1 | Dispute window length | 24h | [01](./docs/plans/01-protocol-freeze.md#decisions) |
| P1 | HTLC hash function | `sha256` | [01](./docs/plans/01-protocol-freeze.md#decisions) |
| P1 | HTLC root algorithm | sorted-keccak (small set) | [01](./docs/plans/01-protocol-freeze.md#decisions) |
| P1 | Min channel amount | 1 USDC (1_000_000) | [01](./docs/plans/01-protocol-freeze.md#decisions) |
| P1 | Hub fee for v1 | 0 (free) | [01](./docs/plans/01-protocol-freeze.md#decisions) |
| P2 | Penalty share | 100% slash | [02](./docs/plans/02-contracts.md#decisions) |
| P2 | Reentrancy guard library | OZ `ReentrancyGuard` | [02](./docs/plans/02-contracts.md#decisions) |
| P5 | Hub DB in production | sqlite + litestream | [05](./docs/plans/05-hub.md#decisions) |
| P5 | Hub WebSocket auth | signed message per request | [05](./docs/plans/05-hub.md#decisions) |
| P6 | Watchtower deployment mode | self-hosted only | [06](./docs/plans/06-watchtower.md#decisions) |
| P6 | Penalty trigger threshold | 50% of dispute window | [06](./docs/plans/06-watchtower.md#decisions) |
| P7 | Wallet connector(s) | WalletConnect via wagmi | [07](./docs/plans/07-wallet-ui.md#decisions) |
| P9 | Hosting platform | Fly.io | [09](./docs/plans/09-ops.md#decisions) |
| P9 | Watchtower placement | separate region from hub | [09](./docs/plans/09-ops.md#decisions) |
| P9 | Alert destination | Discord webhook | [09](./docs/plans/09-ops.md#decisions) |
| P10 | Per-user channel cap | 100 USDC | [10](./docs/plans/10-launch.md#decisions) |
| P10 | Initial hub liquidity | 1000 USDC | [10](./docs/plans/10-launch.md#decisions) |

---

## Glossary (just enough to read the sub-plans)

- **Channel** — a 2-of-2 escrow on-chain between two parties (typically client + hub).
  Funds are deposited once on open, then balances move off-chain via signed updates.
- **State** — a snapshot of a channel: `(balanceA, balanceB, htlcs[], version)` signed
  by both parties. Versions only go up.
- **Cooperative close** — both parties sign a final state and settle in one tx. The
  happy path. Fast and cheap.
- **Unilateral close** — one party (e.g., the hub disappeared) posts the latest state
  they have on-chain. Opens a **dispute window**.
- **Dispute window** — a fixed delay (e.g., 24h) before the unilaterally-posted state
  becomes final, giving the counterparty time to challenge with a newer signed state.
- **HTLC** (Hash-Time-Locked Contract) — a conditional payment inside a channel:
  "$X is locked. Whoever reveals the preimage of hash H before time T claims it.
  Otherwise it refunds." This is how 1-hop routing stays trust-minimized: the hub is
  paid only if the recipient reveals.
- **Watchtower** — a bot that watches the chain for fraudulent old-state submissions
  and posts a counter-state before the dispute window closes. May be self-hosted or a
  third-party service.
- **EIP-712** — Ethereum's typed-data signing standard. Channel states are signed as
  EIP-712 typed data so wallets show humans-readable fields, not raw bytes.
- **1-hop routing** — payments flow `client → hub → recipient` via two paired HTLCs.
  No multi-hop, no graph gossip, no onion routing. Dramatically simpler than Lightning.
- **Hub** — a long-running operator that holds channels with many users and routes
  payments between them. Analogous to a Lightning LSP.
- **Hot wallet** — a private key on a server. Convenient, capped at low balance.
- **Litestream** — a tool that continuously streams a SQLite DB to S3-compatible
  storage for backup and point-in-time restore.

---

## Done when

The project is "dogfood production ready" when **every gate** below is green:

- [ ] All 10 sub-plans report status 🟢
- [ ] Contracts deployed + verified on Taiko mainnet
- [ ] Hub + watchtower running on production infra with monitoring + alerts
- [ ] One end-to-end mainnet payment (client → hub → recipient) succeeds with real USDC
- [ ] Dispute drill on testnet: a deliberately-stale state submission is penalized by the
      watchtower within the dispute window
- [ ] 2-week soak: 3–5 dogfood users, no funds lost, alerts behaved correctly
- [ ] Post-launch retro written, follow-up phase 2 issues filed (DVM, ETH, multi-hub)
