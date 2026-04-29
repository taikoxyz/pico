# tainnel roadmap

> **Target:** dogfood / private launch on Taiko mainnet as an **AI-agent payments
> system**. USDC only, full 1-hop routing, one watchtower, **CLI-as-agent-surface**.
> ~1–2 months end-to-end. The React wallet UI, ERC-8004 / EIP-7702 / TEE-Signer
> backends, MCP / x402, multi-hop, DVM, and ETH support are Phase-2 follow-ups.

This roadmap is the bird's-eye view. Each phase has a detailed plan in
[`docs/plans/`](./docs/plans/). Work the phases in order unless explicitly marked
parallelizable. New readers: start with [`learning/index.html`](./learning/index.html).

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
| P2  | Contracts                   | `[agent]`+`[review]` | 🟡 partial | P1         | deployed + verified on Taiko mainnet; awaits line-by-line review, smoke channel, and owner-key rotation |
| P3  | State machine               | `[agent]`            | 🟡 partial | P1         | core transitions real; signing hashing/verifying, `htlcsRoot`, oracle fixture still pending — the v1 critical path. [03-state-machine.md](./docs/plans/03-state-machine.md) |
| P4  | SDK                         | `[agent]`            | 🔵 not started | P3     | adds `Signer` interface (encrypted-hot-key default backend). [04-sdk.md](./docs/plans/04-sdk.md) |
| P5  | Hub                         | `[agent]`+`[review]` | 🔵 not started | P3, P4 | wire protocol on the hub side (REST + WebSocket). [05-hub.md](./docs/plans/05-hub.md) |
| P6  | Watchtower                  | `[agent]`+`[review]` | 🔵 not started | P3     | [06-watchtower.md](./docs/plans/06-watchtower.md)      |
| P7  | Agent runtime (CLI)         | `[agent]`+`[review]` | 🔵 not started | P4     | extends `apps/cli`; adds `tainnel listen` daemon mode + key management. **Was "Wallet UI"; UI moved to Phase 2.** [07-agent-runtime.md](./docs/plans/07-agent-runtime.md) |
| P8  | E2E + internal audit        | mixed                | 🔵 not started | P5, P6, P7 | agent-to-agent scenarios. [08-e2e-and-audit.md](./docs/plans/08-e2e-and-audit.md) |
| P9  | Ops & infra                 | `[human]` heavy      | ⚪ planning | P8        | [09-ops.md](./docs/plans/09-ops.md)                    |
| P10 | Mainnet dogfood launch      | `[human]` heavy      | ⚪ planning | P9        | [10-launch.md](./docs/plans/10-launch.md)              |
| P11 | Learning materials          | `[agent]`+`[review]` | 🟡 in progress | —      | per-component HTML tutorials in `learning/`. Parallelizable with all other phases. [11-learning.md](./docs/plans/11-learning.md) |

🟢 done · 🟡 in progress / partial · 🔵 not started · ⚪ planning only

### Parallelism opportunities

- **P2 follow-ups and P3 can run in parallel** once P1 freezes the wire format.
- **P11 (learning materials) is parallelizable with all phases.** The audits captured
  during the v1 re-scope already provide enough source material to write every
  component page without blocking on code.
- **P6 (watchtower) can run in parallel with P5 (hub)** — both depend on P3 only.
- **P7 (agent runtime / CLI)** can start once P4 is real enough to mock against.

---

## What to work on next

1. **P3 (state machine)**: finish `hashChannelState` / `verifyChannelStateSignature`,
   `htlcsRoot`, oracle fixture. This is the single v1 critical path — P4, P5, P6, P7 all
   block on it.
2. **P2 follow-ups (parallel with P3)**: line-by-line `[review]` of `PaymentChannel.sol`
   + `Adjudicator.sol`, smoke channel on Taiko mainnet, owner-key rotation. All
   `[human]`, none of them block other phases technically, but they gate P10.
3. **P11 (learning materials, parallel)**: write the HTML tutorials so the user
   understands every component before P10. Editing learning pages alongside code
   keeps them current.
4. **P4 (SDK with `Signer` interface)** as soon as P3 lands. P4 unblocks P5, P7.
5. Don't start P5/P6/P7 against real code until P3 has at least signing + HTLC root
   merged.

---

## Decisions still open

These are all `[human]` decisions surfaced from sub-plans, indexed here so you can
scan them in one place. Each has a default; accepting defaults across the board is the
"dogfood path".

| Phase | Decision | Default | Where |
|---|---|---|---|
| P4  | `Signer` hot key file format | scrypt-derived key + XSalsa20-Poly1305 sealed file at `$XDG_CONFIG_HOME/tainnel/key.enc`, perms 0600 | [04](./docs/plans/04-sdk.md#decisions) |
| P5  | Hub DB in production | sqlite + litestream | [05](./docs/plans/05-hub.md#decisions) |
| P5  | Hub WebSocket auth | signed message per request | [05](./docs/plans/05-hub.md#decisions) |
| P6  | Watchtower deployment mode | self-hosted only | [06](./docs/plans/06-watchtower.md#decisions) |
| P6  | Penalty trigger threshold | 50% of dispute window | [06](./docs/plans/06-watchtower.md#decisions) |
| P7  | `tainnel listen` resilience | auto-reconnect with exponential backoff (200 ms → 30 s, infinite, jittered) | [07](./docs/plans/07-agent-runtime.md#decisions) |
| P9  | Hosting platform | Fly.io | [09](./docs/plans/09-ops.md#decisions) |
| P9  | Watchtower placement | separate region from hub | [09](./docs/plans/09-ops.md#decisions) |
| P9  | Alert destination | Discord webhook | [09](./docs/plans/09-ops.md#decisions) |
| P10 | Per-user channel cap | 100 USDC | [10](./docs/plans/10-launch.md#decisions) |
| P10 | Initial hub liquidity | 1000 USDC | [10](./docs/plans/10-launch.md#decisions) |

---

## Phase 2 follow-ups (explicitly NOT in v1)

When v1 is shipped and stable, these are the candidate next moves. None of them are
designed for in this roadmap.

- **React wallet UI for humans** — the previous P7 scope. Removed from the v1 tree;
  the original outline is preserved in
  [`docs/plans/07-agent-runtime.md`](./docs/plans/07-agent-runtime.md) under "Wallet
  UI in Phase 2" so it can be re-implemented from scratch when Phase 2 begins.
- **ERC-8004 agent identity** — register agent endpoints in the on-chain registry on
  Ethereum mainnet, look up counterparties' channel addresses by agent identity.
- **EIP-7702 / 4337 smart-account on-chain delegation** — scoped session keys for the
  on-chain channel ops (open / close / dispute) so a compromised hot key has a small
  blast radius. Pending Pectra activation on Taiko.
- **TEE / KMS `Signer` backends** — AWS Nitro Enclave, Turnkey, or similar for
  production-grade off-chain signing. Plug in behind the same `Signer` interface from P4.
- **Multi-hop routing** — out of scope until a real reason emerges; 1-hop covers the
  agent-pays-agent workload by design.
- **DVM / Nostr discovery** — the `dvm-adapter` scaffold exists; activate it when DVMs
  become a real channel for agent commerce.
- **ETH (non-USDC) support** — token allowlist already supports it on the contract
  side; client/hub work pending.

> **Project preference:** the project does **not** intend to associate with x402 or
> MCP. If MCP-aware agents want to use the system, a thin external adapter can be
> written on top of the CLI / SDK by anyone. We won't ship one in-tree.

---

## Glossary (just enough to read the sub-plans)

For longer prose explanations and diagrams, see [`learning/index.html`](./learning/index.html).

- **Channel** — a 2-of-2 escrow on-chain between two parties (typically client + hub).
  Funds are deposited once on open, then balances move off-chain via signed updates.
- **State** — a snapshot of a channel: `(balanceA, balanceB, htlcs[], version)` signed
  by both parties. Versions only go up.
- **Cooperative close** — both parties sign a final state and settle in one tx. The
  happy path. Fast and cheap.
- **Unilateral close** — one party (e.g., the hub disappeared) posts the latest state
  they have on-chain. Opens a **dispute window**.
- **Dispute window** — a fixed delay (24h in v1) before the unilaterally-posted state
  becomes final, giving the counterparty time to challenge with a newer signed state.
- **HTLC** (Hash-Time-Locked Contract) — a conditional payment inside a channel:
  "$X is locked. Whoever reveals the preimage of hash H before time T claims it.
  Otherwise it refunds." This is how 1-hop routing stays trust-minimized: the hub is
  paid only if the recipient reveals.
- **Watchtower** — a bot that watches the chain for fraudulent old-state submissions
  and posts a counter-state before the dispute window closes. Self-hosted in v1.
- **EIP-712** — Ethereum's typed-data signing standard. Channel states are signed as
  EIP-712 typed data so the hash a contract verifies matches what was signed.
- **1-hop routing** — payments flow `client → hub → recipient` via two paired HTLCs.
  No multi-hop, no graph gossip, no onion routing. Dramatically simpler than Lightning.
- **Hub** — a long-running operator that holds channels with many users and routes
  payments between them. Analogous to a Lightning LSP.
- **Hot wallet** — a private key on a server. Convenient, capped at low balance.
- **Litestream** — a tool that continuously streams a SQLite DB to S3-compatible
  storage for backup and point-in-time restore.
- **`Signer` interface** — the SDK abstraction over key custody. v1 backend = encrypted
  hot key file. Future backends: KMS, Turnkey, Nitro Enclave, EIP-7702 delegation.
- **`tainnel listen` mode** — a long-running CLI subcommand for receivers. Holds a
  WebSocket session to the hub, accepts inbound HTLCs, reveals preimages, optionally
  watches the chain for dispute events. Same binary as the rest of `tainnel`.
- **Encrypted hot key file** — the on-disk key store that the v1 `Signer` reads.
  Passphrase-derived (scrypt) key, sealed with XSalsa20-Poly1305. Permissions 0600.

---

## Done when

The project is "dogfood production ready" when **every gate** below is green:

- [ ] All 11 sub-plans report status 🟢
- [ ] Contracts deployed + verified on Taiko mainnet
- [ ] Hub + watchtower running on production infra with monitoring + alerts
- [ ] CLI installable via `pnpm tainnel`; agent can pay another agent end-to-end on
      mainnet using `tainnel pay`
- [ ] Receiver-side: `tainnel listen` accepts an inbound HTLC, reveals the preimage,
      and the channel state advances correctly
- [ ] One end-to-end mainnet payment (agent → hub → agent) succeeds with real USDC
- [ ] Dispute drill on mainnet (≤ MIN_CHANNEL_AMOUNT funds): a deliberately-stale state
      submission is penalized by the watchtower within the dispute window
- [ ] 2-week soak: 3–5 dogfood agents/users, no funds lost, alerts behaved correctly
- [ ] Learning materials in `learning/` cover every component, all internal links
      resolve, and the gap list on each page matches the current `ROADMAP.md`
- [ ] Post-launch retro written, follow-up Phase 2 issues filed (wallet UI, ERC-8004,
      EIP-7702, TEE Signer, DVM, ETH, multi-hub)
