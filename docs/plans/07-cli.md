# P7 — CLI

**Status:** 🟢 done — `apps/cli/` is wired end-to-end against `@tainnel/sdk`,
99 tests pass at 96.94% lines / 95.55% functions, and the E2E test runs the
`open → pay → close` happy path against the real-WS mock hub. Manual mainnet
smoke is tracked as a P10 prereq.
**Blocks:** P10 (the dogfood-launch user-facing path)
**Depends on:** P4 (SDK)
**Parallelizable with:** P5 follow-ups, P6 — done.

## Why this exists (and why it isn't a wallet UI or an ERC-8004 agent)

tainnel's v1 audience is autonomous agents and operators — not non-engineer
humans. The user-facing surface is the `tainnel` CLI: scriptable,
agent-friendly, fast to iterate, observable from logs. AI agents shell out
to the CLI as a tool, or import `@tainnel/sdk` directly. There is no
browser, no wagmi, no WalletConnect.

ERC-8004 (Trustless Agents) is out of scope for v1 and deferred to
Phase 2. Canonical Taiko deployments already exist (`IdentityRegistry`
`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, `ReputationRegistry`
`0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` on Mainnet; parallel
addresses on Hoodi). Phase 2 will pin to these and add identity /
reputation helpers — no contracts deployed by us. v1 dogfood has no
discovery problem because every counterparty is one we operate.

## Decisions

### D7.1 Keystore handling
- **Default:** `TAINNEL_PRIVATE_KEY` env var (raw `0x…` hex). Simplest,
  matches typical CLI / agent-runtime ergonomics. Documented loudly: do
  not check this into shell history; use a process manager that injects
  secrets.
- **Tradeoff:** an encrypted JSON keystore (viem `keystore.json` shape +
  passphrase via `TAINNEL_KEYSTORE_PASSPHRASE`) is more secure but adds
  friction. Phase 2 if anyone asks.
- Decision: ☑ env var only (default)

### D7.2 Output format
- **Default:** pretty by default; `--json` flag emits machine-readable
  JSON. Both formats covered by the same code path (a `Renderer`
  interface with `pretty` and `json` implementations).
- **Refinement during impl:** `--json` is a global root-program flag,
  not a per-command flag. Set once at the top, picked up by every
  subcommand.
- Decision: ☑ accept default

### D7.3 Hub URL convention
- **Default:** `--hub <url>` accepts EITHER a WebSocket URL (`ws://`,
  `wss://`) or an HTTP base (`http://`, `https://`); the CLI derives the
  sibling. Health check is `GET <hub>/health` (NOT `/v1/health` —
  matches what the running hub serves).
- The `TAINNEL_HUB_URL` env var supplies a default.
- Decision: ☑ accept default (single flag, dual scheme)

### D7.4 Storage location
- **Default:** `~/.tainnel/channels/` via `FileStorage` (already shipped
  in P4). Override with `--storage-dir <path>` or `TAINNEL_STORAGE_DIR`.
- Decision: ☑ accept default

## Implementation tasks

### SDK addition (`packages/sdk/src/wallet.ts`)

- [x] `[agent]` Add `PrivateKeyWalletAdapter` next to `ViemWalletAdapter`
      and `BrowserWalletAdapter`.
      - Constructor: `new PrivateKeyWalletAdapter({ privateKey: Hex })`.
      - Implements `WalletAdapter` (`getAddress`, `signTypedData`,
        `signMessage`).
      - Wraps `viem`'s `privateKeyToAccount` — already a transitive dep
        of `packages/sdk/`.
      - ~40 LOC.
- [x] `[agent]` Re-export `PrivateKeyWalletAdapter` from
      `packages/sdk/src/index.ts`.
- [x] `[agent]` Tests in `packages/sdk/src/wallet.test.ts`: address
      recovery, EIP-712 signature validity (cross-checked against
      `ViemWalletAdapter` for the same key), error on missing key, error
      on malformed key, no key in error messages.

### SDK addition (`packages/sdk/src/chain-viem.ts`) — added beyond original list

- [x] `[agent]` New file: `ViemChainAdapter` implementing `ChainAdapter`.
      Auto-approves USDC before `openChannel`. Mirrors patterns from
      `apps/hub/src/dispute-handler.ts` and
      `apps/watchtower/src/responder.ts`.
- [x] `[agent]` Implements `openChannel`, `closeCooperative`,
      `closeUnilateral`, `waitForFinalized`.
- [x] `[agent]` Re-exported from `packages/sdk/src/index.ts`.
- [x] `[agent]` Mocked-viem-clients unit tests (anvil-backed coverage
      tracked as a P5 follow-up).
- [x] `[agent]` `CloseUnilateralTxArgs` extended with `closerSide?: 'A' |
      'B'`; `ChannelClient.unilateralClose` computes and passes it.

### Hub addition (`apps/hub/src/api/index.ts`) — added beyond original list

- [x] `[agent]` Extended `/health` to include `address`, `chainId`,
      `version` so the CLI can discover the hub identity from a single
      `--hub` URL. Threaded `version` through `apps/hub/src/server.ts`
      from `package.json`. Existing integration test updated.

### CLI wiring (`apps/cli/src/`)

- [x] `[agent]` `lib/keystore.ts` — load private key from
      `TAINNEL_PRIVATE_KEY`; throw a friendly error if missing. Never
      logs the key, never echoes it back. Tests assert no 64-char hex
      substring leaks into the malformed-key error message.
- [x] `[agent]` `lib/url.ts` — `deriveHubUrls(input)` returning
      `{ ws, http }` pair. Accepts ws/wss/http/https; throws on
      unsupported schemes.
- [x] `[agent]` `lib/render.ts` — `Renderer` interface with `pretty` and
      `json` implementations. JSON serializes bigints as decimal
      strings; one JSON object per line.
- [x] `[agent]` `lib/chain.ts` — factory returning a `ChainAdapter`.
      Two modes via `TAINNEL_CHAIN_MODE`: `viem` (default; real on-chain
      with `ViemChainAdapter`) and `memory` (TEST-ONLY, the in-memory
      adapter — used by the E2E test).
- [x] `[agent]` `lib/in-memory-chain.ts` — `InMemoryChainAdapter` lifted
      from `examples/sdk-mock-flow.ts`. Test-only; documented.
- [x] `[agent]` `lib/client.ts` — `buildClient(opts)` factory that loads
      keystore + storage + transport + chain and returns a wired
      `ChannelClient`. Eagerly connects the WebSocket so commands like
      `pay` (which never call `open()`) can issue request/reply
      round-trips. Hub identity discovered via `/health` OR pinned via
      `TAINNEL_HUB_ADDRESS` + `TAINNEL_HUB_CHAIN_ID` env vars (E2E and
      mock-hub friendly).
- [x] `[agent]` `lib/channel-select.ts` — picks the right channel for
      `pay` / `close`: matches `--channel-id` if given, else the unique
      open channel with this hub, else throws a clear error.
- [x] `[agent]` `lib/units.ts` — `parseUsdc` / `formatUsdc` (6-decimal
      bigint helpers).
- [x] `[agent]` `lib/errors.ts` — `CliError` with `code` and `exitCode`.

#### `tainnel channel open --hub <url> --amount <usdc>`
- [x] `[agent]` Parse `--amount` (USDC, 6 decimals) into bigint.
- [x] `[agent]` Build `ChannelClient`, call `open()`.
- [x] `[agent]` Render: channel id, counterparty (= hub address), amount,
      status. (txHash placeholder until the SDK surfaces it; on-chain
      receipt will fill it in via `ViemChainAdapter`.)
- [x] `[agent]` Optional `--counterparty-amount`, `--storage-dir`.

#### `tainnel channel list`
- [x] `[agent]` Read all locally-known channels via
      `ChannelClient.list()` (when `--hub` is given) OR direct
      `FileStorage` read (when `--hub` is omitted, no hub round-trip).
- [x] `[agent]` Render a table: id, status, our balance, counterparty
      balance, pending HTLCs.

#### `tainnel channel close <id> [--cooperative|--unilateral]`
- [x] `[agent]` Drive `ChannelClient.close({ cooperative: true })` by
      default. `--unilateral` flips it.
- [x] `[agent]` Optionally `await client.waitForFinalized(id)` (skipped
      with `--no-wait-finalized`; gracefully degraded when the chain
      adapter doesn't support it, e.g. memory mode).
- [x] `[agent]` Render: final balances (from our perspective),
      finalize tx hash, status.

#### `tainnel pay --to <address> --amount <usdc> --via <hub>`
- [x] `[agent]` Validate `--to` (EVM address via viem's `isAddress`,
      strict=false to allow lowercase); convert `--amount` to bigint.
- [x] `[agent]` Drive `ChannelClient.pay({ to, amount, memo })` via
      `selectChannel` (auto-pick the unique open channel with the hub,
      or `--channel-id` for explicit selection).
- [x] `[agent]` Render: channel id, htlc id, preimage, settled timestamp.

#### `tainnel hub status <url>`
- [x] `[agent]` GET `<hub>/health`. Pretty-print status, address,
      chainId, version, db/chain readiness. Exit code 2 on degraded.

### Documentation

- [x] `[agent]` Rewrote `apps/cli/README.md` with: install + build, env
      var setup, command reference, the v1 happy-path script, JSON
      output examples for AI-agent consumers, storage layout note,
      security note about not pasting keys into shell history, deferred
      items.

### Tests

- [x] `[agent]` Unit tests for each command's argument parsing and error
      handling. Use a mock `ChannelClient` (via `vi.mock('../lib/client.js')`)
      so commands are tested without a live hub.
- [x] `[agent]` E2E test in `apps/cli/src/e2e.test.ts`: spawns two
      `tainnel` subprocesses with two different keys; brings up the
      real-WS mock hub from `@tainnel/test-utils`; runs open → pay →
      close end-to-end with `TAINNEL_CHAIN_MODE=memory` and a
      deterministic test preimage so `payment.settle` succeeds; asserts
      the JSON outputs and the hub's `seenPayments` log.
- [x] `[agent]` Coverage threshold added to `apps/cli/vitest.config.ts`
      at 80% lines/branches/functions/statements (achieved 96.94% lines,
      84.18% branches, 95.55% funcs at submission time).

## Demo dogfood flow (the v1 happy path)

1. Operator (or AI agent) sets `TAINNEL_PRIVATE_KEY` to keypair-A and
   `TAINNEL_HUB_URL` to the hub WebSocket URL.
2. `tainnel channel open --hub <url> --amount 5` — opens a channel funded
   with 5 USDC.
3. Second process / second keypair (B) does the same.
4. From keypair-A: `tainnel pay --to <B's address> --amount 1 --via <url>`
   — payment routes A → hub → B, settles.
5. `tainnel channel close <id> --hub <url>` from each side; final
   balances on-chain match expectation.

This entire flow is scriptable. An AI agent driving it shells out to
`tainnel` and parses `--json` output (or imports `@tainnel/sdk`
directly — both work).

## `[review]` gates

- [x] `[review]` Read `apps/cli/src/lib/keystore.ts`. Confirmed: never
      logs the raw key, never echoes it back, never writes it to disk.
      Test asserts no 64-char hex substring leaks into error messages.
- [ ] `[review]` Daniel manually runs `tainnel channel open` on Hoodi
      (or mainnet) at least once before P10 launch. Tracked as the
      mainnet smoke gate in [ROADMAP.md](../../ROADMAP.md). Currently
      blocked by deployer USDC balance + Hoodi contract deployment.

## Done when

- [x] All `[agent]` boxes checked
- [x] `pnpm --filter @tainnel/cli test` ≥ 80% lines (achieved 96.94%)
- [x] E2E `open → pay → close` runs green against the mock hub
- [x] `tainnel --help` documents every command above
- [ ] Manually tested on mainnet (or Hoodi once contracts deploy) by
      Daniel — moved to the P10 prereq list.
- [ ] Branch merged with `feat(cli): wire channel open/pay/close
      end-to-end`

## Out of scope (deferred follow-ups)

- `tainnel dev anvil-fork` — local Taiko fork helper. The stub in
  `commands/dev.ts` still throws `not implemented`. Defer to a
  dev-ergonomics follow-up; not on the dogfood critical path.
- Encrypted JSON keystore (`--keystore` flag). D7.1 fallback. Add iff
  someone asks.
- Anvil-backed integration tests in CI for `ViemChainAdapter`. Mocked
  viem clients are used in this PR; anvil version follows once P5 anvil
  work lands.
- `/v1/hub/info` endpoint. The `/health` extension covers what the CLI
  needs today.
