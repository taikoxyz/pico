# P7 — Agent runtime (CLI)

> **Scope change:** P7 was originally "Wallet UI" — a React app for humans. The v1
> target is an AI-agent payments network, so the agent surface is the CLI and the
> wallet UI is a Phase 2 follow-up. The previous `apps/wallet-ui` skeleton has been
> **deleted** from the tree to keep v1 focused. The Phase 2 starting outline lives
> at the bottom of this file. This phase fully describes the v1 agent runtime.

**Status:** 🟢 done — `pnpm --filter @tainnel/cli test` passes after workspace
packages are built.
`apps/cli` has keys, channel, invoice, pay, listen, hub, and dev commands, plus a
mock-hub pay/listen integration test.
**Blocks:** —
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

## Implementation record

The CLI now includes:

- Key management commands: `keys init`, `keys import`, and `keys show`, backed by the
  SDK key-file format.
- Channel commands: `channel open`, `channel list`, and `channel close`.
- Invoice commands: `invoice create`, `invoice list`, and `invoice show`.
- Payment commands for both invoice mode and keysend mode, with `--json` output for
  non-TypeScript agents.
- `tainnel listen` as the long-running receiver process.
- `hub status`, `dev anvil-fork`, and `dev mock-hub`.
- Unit tests for command parsing and runtime helpers, plus a mock-hub pay/listen
  integration test.

There are no remaining P7-specific blockers for the controlled mainnet real-money E2E
test. The remaining work is to connect these CLI flows to the real hub, watchtower,
ops, and P8 scenario harness.

## Quickstart for agent authors

The README and learning page should make this trivially copy-pastable:

```bash
# one-time setup
pnpm install
pnpm tainnel keys init
pnpm tainnel channel open --hub https://hub.example.com --amount 25

# Pattern A: invoice flow (default for paid APIs)
#   step 1 — receiver creates an invoice and serves it from their HTTP API
INVOICE=$(pnpm tainnel invoice create --amount 0.05 --memo "service foo")
#   step 2 — sender pays the invoice and gets the preimage as a receipt
pnpm tainnel pay --invoice "$INVOICE" --json

# Pattern B: keysend (push payment, no prior coordination)
pnpm tainnel pay --to 0xRecipient --amount 0.05 --keysend --recipient-pubkey 0x... --json

# receive (run in the background; both modes settle through this)
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
  once before the P10 controlled mainnet real-money test.

## Done when

- `pnpm --filter @tainnel/cli test` passes.
- Integration test (pay → listen via mock hub) is green.
- An any-language agent can pay another agent by shelling out to `tainnel pay --json`
  and parsing the output.
- The roadmap marks P7 🟢 and does not list P7 as a blocker for mainnet E2E testing.

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
