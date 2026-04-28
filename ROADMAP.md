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
| P1  | Protocol freeze             | `[human]` heavy      | 🟢 done    | P0         | merged in `feat(protocol): freeze v1 wire format`     |
| P2  | Contracts                   | `[agent]`+`[review]` | 🟡 partial | P1         | code 🟢 (117 tests, 100% coverage, deployed + verified, line-by-line review done, dispute() bug fixed via UUPS); awaits two mainnet ops gates (smoke channel, owner-key rotation) — P10 prereqs, not P5 blockers |
| P3  | State machine               | `[agent]`            | 🟢 done    | P1         | 109 tests, 100% coverage; consumed by SDK — [03-state-machine.md](./docs/plans/03-state-machine.md) |
| P4  | SDK                         | `[agent]`            | 🟢 done    | P3         | 105+ tests, 92% coverage; ChannelClient, IndexedDB, BrowserWallet, real-WS mock hub — [04-sdk.md](./docs/plans/04-sdk.md) |
| P5  | Hub                         | `[agent]`+`[review]` | 🔵 not started | P3, P4 | [05-hub.md](./docs/plans/05-hub.md)                    |
| P6  | Watchtower                  | `[agent]`+`[review]` | 🔵 not started | P3     | [06-watchtower.md](./docs/plans/06-watchtower.md)      |
| P7  | Wallet UI                   | `[agent]`+`[review]` | 🔵 not started | P4     | [07-wallet-ui.md](./docs/plans/07-wallet-ui.md)        |
| P8  | E2E + internal audit        | mixed                | 🔵 not started | P5, P6, P7 | [08-e2e-and-audit.md](./docs/plans/08-e2e-and-audit.md) |
| P9  | Ops & infra                 | `[human]` heavy      | ⚪ planning | P8        | [09-ops.md](./docs/plans/09-ops.md)                    |
| P10 | Mainnet dogfood launch      | `[human]` heavy      | ⚪ planning | P9        | [10-launch.md](./docs/plans/10-launch.md)              |

🟢 done · 🟡 in progress / partial · 🔵 not started · ⚪ planning only

### Parallelism opportunities

P2/P3/P4 are all complete (P2 code-complete; only mainnet ops gates remain).
The next fan-out is:

- **P5 (hub) ‖ P6 (watchtower)** — P6 depends on P3 only and does not need
  the hub running, so it can start at the same time as P5.
- **P7 (wallet UI)** — can start as soon as P5's WebSocket protocol is real
  enough to point a wallet at; until then, P4's `@tainnel/test-utils`
  real-WS mock hub is a sufficient stand-in.

---

## What to work on next

P0–P4 are complete from an engineering standpoint. **The next engineering
milestone is P5 (hub).** P6 and P7 can be picked up in parallel — see the
section above.

1. **P5 (hub)** — unblocked. State machine, SDK, and the SDK↔hub WebSocket
   wire contract (`subscribe`, `pay` / `payment.settle` / `payment.fail`,
   `close.request` / `close.counter` / `close.reject`) are all locked. The
   real-WS mock hub at `packages/test-utils/src/mock-hub.ts` is the
   reference behaviour the production hub should match.
2. **P6 (watchtower)** — unblocked, parallel with P5.
3. **P7 (wallet UI)** — can start once P5's WS server is reachable; before
   that, point it at the mock hub from P4.

### Outstanding mainnet ops gates (P10 prereqs, not P5 blockers)

The contracts code is hub-ready, but two `[human]` gates must close before
real users deposit USDC on mainnet. They do **not** block hub
implementation — that work can target Hoodi testnet or a local fork.

- **Smoke channel.** Open a ≤ MIN_CHANNEL_AMOUNT channel on mainnet and
  confirm `ChannelOpened` on Taikoscan. Currently blocked by the deployer
  (`0x327fa3...c458`) holding 0 USDC.
- **Owner-key rotation.** The deployer key is the current owner of both
  proxies and was pasted into a Claude session — treat as compromised.
  `transferOwnership` from a clean key before any real user funds.

---

## Decisions still open

These are all `[human]` decisions surfaced from sub-plans, indexed here so you can
scan them in one place. Each has a default; accepting defaults across the board is the
"dogfood path".

| Phase | Decision | Default | Where |
|---|---|---|---|
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
- [ ] Dispute drill on mainnet (≤ MIN_CHANNEL_AMOUNT funds): a deliberately-stale state
      submission is penalized by the watchtower within the dispute window
- [ ] 2-week soak: 3–5 dogfood users, no funds lost, alerts behaved correctly
- [ ] Post-launch retro written, follow-up phase 2 issues filed (DVM, ETH, multi-hub)
