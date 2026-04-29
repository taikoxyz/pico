# tainnel roadmap

> **Target:** dogfood / private launch on Taiko mainnet. USDC only, full 1-hop routing,
> one watchtower. **CLI-only user surface — no browser wallet UI.** ~1–2 months
> end-to-end. DVM, ETH support, and ERC-8004 agent identity are Phase-2 follow-ups.

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
| P5  | Hub                         | `[agent]`+`[review]` | 🟡 partial | P3, P4 | first cut: 26 tests pass, sqlite + WS protocol matches SDK + chain-watcher + dispute handler. Deferred: signed-envelope auth, anvil integration, coverage gate — [05-hub.md](./docs/plans/05-hub.md) |
| P6  | Watchtower                  | `[agent]`+`[review]` | 🟢 done    | P3     | 35 tests pass, full pipeline (storage + reorg-aware watcher + responder + scheduler + /health,/metrics) — [06-watchtower.md](./docs/plans/06-watchtower.md) |
| P7  | CLI                         | `[agent]`+`[review]` | 🟢 done    | P4     | 99 tests pass at 96.94% lines; `channel open/list/close`, `pay`, `hub status` wired end-to-end; E2E open→pay→close green vs mock hub. `ViemChainAdapter` + `PrivateKeyWalletAdapter` shipped in SDK. Manual mainnet smoke moved to P10 prereqs — [07-cli.md](./docs/plans/07-cli.md) |
| P8  | E2E + internal audit        | mixed                | 🔵 not started | P5, P6, P7 | [08-e2e-and-audit.md](./docs/plans/08-e2e-and-audit.md) |
| P9  | Ops & infra                 | `[human]` heavy      | ⚪ planning | P8        | [09-ops.md](./docs/plans/09-ops.md)                    |
| P10 | Mainnet dogfood launch      | `[human]` heavy      | ⚪ planning | P9        | [10-launch.md](./docs/plans/10-launch.md)              |

🟢 done · 🟡 in progress / partial · 🔵 not started · ⚪ planning only

### Parallelism opportunities

P2/P3/P4 are complete (P2 code-complete; only mainnet ops gates remain). P6
and P7 are 🟢 done. P5 has a working first cut covering the SDK wire contract
end to end. The remaining fan-out is:

- **P5 follow-ups** (signed-envelope auth, anvil-backed integration,
  coverage gate) can land independently. Anvil-backed integration also gates
  the `ViemChainAdapter`'s anvil tests.
- **Mainnet/Hoodi smoke for the CLI** (P10 prereq, see below) — Daniel
  runs `tainnel channel open` against a deployed hub once the deployer key
  has USDC and Hoodi contracts deploy.

---

## What to work on next

P0–P4, P6, and P7 are complete from an engineering standpoint. P5 (hub)
has a working first cut.

1. **P5 follow-ups** — to flip from 🟡 partial to 🟢 done:
   - Signed-envelope WebSocket auth (D5.2). The wire handler accepts a bare
     `{id, kind, payload}` today; wrap it with `{nonce, ts, payload, sig}`
     verification. The `seen_nonces` table is already in place.
   - Anvil-backed integration: replace the chain mock in
     `apps/hub/test/integration.test.ts` with a real anvil run plus the
     deployed contracts (this also gates P10's dispute drill, AND the
     `ViemChainAdapter`'s anvil-backed test). The current test mocks the
     chain and is marked `// TODO P10`.
   - Coverage report: `pnpm --filter @tainnel/hub test --coverage`. The
     vitest threshold of ≥70% is set; current numeric coverage is unmeasured.
2. **P8 (E2E + internal audit)** — now unblocked. P5 has a first cut, P6
   is done, P7 is done. The CLI's E2E test already exercises the
   open→pay→close happy path; broaden coverage to dispute paths once P5's
   anvil work lands.

### Outstanding mainnet ops gates (P10 prereqs, not P5 blockers)

The contracts code is hub-ready, but three `[human]` gates must close before
real users deposit USDC on mainnet. They do **not** block hub
implementation — that work can target Hoodi testnet or a local fork.

- **Smoke channel.** Open a ≤ MIN_CHANNEL_AMOUNT channel on mainnet and
  confirm `ChannelOpened` on Taikoscan. Currently blocked by the deployer
  (`0x327fa3...c458`) holding 0 USDC.
- **Owner-key rotation.** The deployer key is the current owner of both
  proxies and was pasted into a Claude session — treat as compromised.
  `transferOwnership` from a clean key before any real user funds.
- **Manual CLI smoke.** Run `tainnel channel open --hub
  <mainnet-hub-url> --amount 1` (≤ MIN_CHANNEL_AMOUNT) on mainnet,
  end-to-end pay to a second key, then cooperative close. Confirms the
  `ViemChainAdapter` + USDC auto-approve path against real contracts.
  Blocked by deployer USDC balance + hub deployment.

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
- [ ] One end-to-end mainnet payment (CLI process A → hub → CLI process B) succeeds with real USDC
- [ ] Dispute drill on mainnet (≤ MIN_CHANNEL_AMOUNT funds): a deliberately-stale state
      submission is penalized by the watchtower within the dispute window
- [ ] 2-week soak: 3–5 dogfood users, no funds lost, alerts behaved correctly
- [ ] Post-launch retro written, follow-up phase 2 issues filed (DVM, ETH, multi-hub, ERC-8004 agent identity)
