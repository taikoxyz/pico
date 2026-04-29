# P7 — Agent runtime (CLI)

> **Scope change:** P7 was originally "Wallet UI" — a React app for humans. The v1
> target is an AI-agent payments network, so the agent surface is the CLI and the
> wallet UI is a Phase 2 follow-up. The previous `apps/wallet-ui` skeleton has been
> **deleted** from the tree to keep v1 focused. The Phase 2 starting outline lives
> at the bottom of this file. This phase fully describes the v1 agent runtime.

**Status:** 🔵 not started — `apps/cli` has command shells (`hello`, `channel open`,
`channel list`, `channel close`, `pay`, `hub status`, `dev anvil-fork`). No `Signer`
backend, no `tainnel listen` mode, no key management commands.
**Blocks:** P10 (the user-facing v1 path; agents shell out to the CLI)
**Effort:** ~1 week
**Depends on:** P4 (SDK with `Signer` interface)
**Parallelizable with:** P5, P6 once P4 is enough to mock against

## What this phase delivers

- Extends `apps/cli` so it is the canonical agent interface for v1.
- Adds `tainnel listen` long-running subcommand for receivers and chain-watching agents
  (lnd-style, same binary, different mode).
- Adds key-management commands (`tainnel keys init`, `tainnel keys unlock`).
- Implements the v1 `Signer` backend defined in P4: passphrase-encrypted hot key file
  on disk.
- Integration tests exercise an outbound payment from one CLI process into a `tainnel
  listen` process via a mock hub.

## Decisions

### D7.1 Agent surface
- **Default:** CLI is the agent interface. Any-language agents shell out to
  `pnpm tainnel pay …` or run `tainnel listen` in the background. No separate `agentd`
  binary, no MCP server, no x402.
- **Why this is a decision worth recording:** the project explicitly does not associate
  with MCP or x402. If an MCP-aware agent wants to use the system, it can wrap the CLI
  externally.
- Decision: ☑ CLI-as-agent-surface (locked in v1 re-scope)

### D7.2 `Signer` backend in v1
- **Default:** passphrase-encrypted hot key file. scrypt-derived key
  (N=2^17, r=8, p=1), sealed with XSalsa20-Poly1305 via libsodium. Path defaults to
  `$XDG_CONFIG_HOME/tainnel/key.enc`. Permissions 0600 enforced at write.
- **Tradeoff:** matches Lightning's `lnd` model; sufficient for low-value dogfood.
  Production-grade signing (TEE / KMS / 7702 delegation) plugs in behind the same
  `Signer` interface in Phase 2.
- Decision: ☐ encrypted hot key file (default) ☐ raw private key in env var (test-only)

### D7.3 `tainnel listen` resilience
- **Default:** auto-reconnect with exponential backoff (200 ms → 30 s, jittered,
  infinite retry). Keeps a journal of in-flight HTLCs in the SDK storage so a kill-
  restart cycle resumes mid-payment. Logs `LISTEN_HUB_DOWN` every 5 minutes when
  disconnected so external alerting can fire.
- Decision: ☐ accept default ☐ cap retries

### D7.4 Unlock model
- **Default:** prompt for passphrase on each invocation. Inherit `TAINNEL_PASSPHRASE`
  from env if set (test/CI use only — warn at startup). For `tainnel listen`, prompt
  once at startup; the daemon keeps the unlocked key in memory until exit.
- Decision: ☐ per-invocation prompt (default) ☐ persistent unlock daemon (deferred)

## Implementation tasks

### Key-management commands
- [ ] `[agent]` `tainnel keys init [--out <path>]` — generate a fresh secp256k1 key,
      prompt for passphrase, write encrypted file at the resolved path. Print public
      address. Refuse to overwrite existing files unless `--force` is passed.
- [ ] `[agent]` `tainnel keys import [--from <hex>] [--out <path>]` — accept a private
      key (hex or BIP-39 mnemonic), passphrase-encrypt, write file. Refuse to log the
      raw key.
- [ ] `[agent]` `tainnel keys show [--path <path>]` — print public address only.
      Never decrypt the file unless explicitly asked via a separate `--reveal-private`
      flag (and even then, gate on a fresh passphrase prompt).
- [ ] `[agent]` File format: libsodium `crypto_secretbox` over the raw private-key
      bytes. KDF parameters and ciphertext bundled in a small JSON envelope so future
      versions can rotate algorithms.

### Channel commands (already stubbed; wire to the SDK)
- [ ] `[agent]` `tainnel channel open --hub <url> --amount <usdc>` — load `Signer`
      from key file, build a `ChannelClient` (transport + storage + signer), call
      `client.open(...)`. Print channel id + tx hash. Persist channel record.
- [ ] `[agent]` `tainnel channel list` — read storage, print all channel ids,
      counterparties, balances, statuses. Output mode: human table, or `--json` for
      agents.
- [ ] `[agent]` `tainnel channel close <id> [--cooperative|--unilateral]` — invoke
      `client.close()` with the chosen path. Print final tx hash.

### Payment commands
- [ ] `[agent]` `tainnel pay --to <addr> --amount <usdc> [--via <hub>] [--memo <s>]`
      — call `client.pay({to, amount, memo})`. Print payment id + state on each
      transition (HTLC sent → preimage revealed → settled). Exit non-zero on failure
      and print typed error reason.
- [ ] `[agent]` `--json` flag prints one JSON object per state transition, one per
      line. Lets a non-TS agent parse without writing a viem stack.

### `tainnel listen` (new daemon-mode subcommand)
- [ ] `[agent]` `tainnel listen [--hub <url>] [--channel <id>...]` — start a long-
      running process that:
      1. Decrypts hot key once at startup.
      2. Constructs a `ChannelClient` and connects WebSocket transport.
      3. Subscribes to channels (default: all channels in storage; `--channel` to
         narrow).
      4. Receives signed `Update` / HTLC offers from the hub.
      5. Validates with state-machine, generates / reveals preimage, signs counter-
         state, persists, returns the signed counter-state to the hub.
      6. Optionally watches `PaymentChannel` events on chain (use the SDK's chain
         interface; do **not** duplicate a watchtower — that's P6's job).
      7. Idempotent on disconnect/reconnect: state journal in the SDK storage keeps
         a per-channel resume cursor.
- [ ] `[agent]` Receiver flow (the agent-pays-agent unlock): an inbound HTLC arrives
      → listen verifies amount/expiry → reveals preimage → ack to hub → channel
      version increments. The agent process running listen mode is the canonical
      "Bob" in the agent-to-agent flow.
- [ ] `[agent]` Graceful shutdown: SIGINT → drain in-flight HTLCs (best effort),
      persist journal, close WS, exit 0.
- [ ] `[agent]` Structured logs (pino) at every state transition. `--log-format json`
      for machine consumers.

### Hub status (debug)
- [ ] `[agent]` `tainnel hub status <url>` — already stubbed. Hit `GET /v1/health`,
      print health status + version + chain reachability.

### Dev helpers
- [ ] `[agent]` `tainnel dev anvil-fork` — already stubbed. Spawn an anvil that forks
      Taiko mainnet at a pinned block, deploy contracts via forge, print RPC URL +
      contract addresses.
- [ ] `[agent]` `tainnel dev mock-hub` — start an in-process mock hub from
      `@tainnel/test-utils` so an agent author can wire a CLI to it locally without
      running the real hub.

### Tests
- [ ] `[agent]` Unit tests for each command's argument parsing and error paths.
- [ ] `[agent]` Integration test (`apps/cli/test/integration/`):
      - Spawn `tainnel dev anvil-fork`, deploy contracts.
      - Spawn `tainnel dev mock-hub`.
      - In one process, run `tainnel listen --hub <mock>`.
      - In another process, run `tainnel pay --to <listen address> --amount 0.1`.
      - Assert listen process exits cleanly on SIGINT and the channel state on disk
        reflects the post-payment version.
- [ ] `[agent]` Persistence-survives-crash test: kill `tainnel listen` mid-payment;
      restart; assert the channel state recovers and the in-flight HTLC resolves.
- [ ] `[agent]` Coverage ≥ 70% lines on `apps/cli`.

## Quickstart for agent authors

The README and learning page should make this trivially copy-pastable:

```bash
# one-time setup
pnpm install
pnpm tainnel keys init
pnpm tainnel channel open --hub https://hub.example.com --amount 25

# pay
pnpm tainnel pay --to 0xRecipient --amount 0.05 --json

# receive (run in the background)
pnpm tainnel listen --hub https://hub.example.com &
```

## `[review]` gates

- You read `cmd/listen.ts` (or wherever the listen-mode handler lives). The
  signed-first-or-not ordering between "ack to hub" and "persist counter-state" is
  the single most safety-critical line in the agent runtime.
- You read `signer/hot-key-file.ts`. Confirm permissions 0600 on write, scrypt params
  match the spec, and the file refuses to load with a wrong passphrase rather than
  returning a bogus key.
- You manually run `tainnel pay` between two local CLIs through the mock hub at least
  once before P10 mainnet launch.

## Done when

- All `[ ]` boxes checked
- `pnpm --filter @tainnel/cli test --coverage` ≥ 70% lines
- Integration test (pay → listen via mock hub) green
- An any-language agent can pay another agent by shelling out to `tainnel pay --json`
  and parsing the output
- Branch merged with `feat(cli): agent-runtime commands incl. listen mode + signer`

## Wallet UI in Phase 2

The original P7 wallet UI was deleted from the tree as part of the v1 re-scope. The
outline is preserved here so a Phase 2 plan can be written from this starting point
without re-deriving the requirements:

- **Stack:** React 18 + Vite + TypeScript + Tailwind, wagmi v2 + viem, IndexedDB
  storage from the SDK.
- **Connectors:** WalletConnect (via wagmi) + injected (MetaMask).
- **Pages:** dashboard, open channel, pay, settings. (DVM browser was originally
  planned as a placeholder; revisit if/when DVM discovery becomes a Phase 2
  priority.)
- **Hosting:** Cloudflare Pages, env-built (`VITE_HUB_URL`, `VITE_TAIKO_CHAIN_ID`,
  `VITE_PAYMENT_CHANNEL_ADDRESS`).
- **Signer backend:** browser-wallet adapter (a `Signer` implementation that delegates
  to wagmi's connected wallet via EIP-1193). This reuses the same `Signer` interface
  shipped in v1; no SDK changes needed.
- **Visual polish bar:** functional ugly is acceptable for Phase 2 dogfood. Polish
  pass before any public launch.

When Phase 2 begins, file `docs/plans/12-wallet-ui.md`, recreate `apps/wallet-ui/`
from a clean Vite scaffold using the bullets above, and reuse the v1 SDK with a new
browser-wallet `Signer` backend.
