# P7 — CLI

**Status:** 🟡 partial — `apps/cli/` scaffold exists (commander.js binary
wired as `pnpm tainnel <cmd>`, command stubs for `hello`, `channel`, `pay`,
`hub`, `dev`, depends on `@tainnel/sdk`); no SDK wiring yet
**Blocks:** P10 (the dogfood-launch user-facing path)
**Effort:** ~3–4 days
**Depends on:** P4 (SDK)
**Parallelizable with:** P5 follow-ups, P6 — `apps/cli/` runs end-to-end
against the P4 `@tainnel/test-utils` real-WS mock hub today.

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
- Decision: ☐ env var only (default) ☐ env var + `--keystore` JSON

### D7.2 Output format
- **Default:** pretty by default; `--json` flag emits machine-readable
  JSON. Both formats covered by the same code path (a `Renderer`
  interface with `pretty` and `json` implementations).
- Decision: ☐ accept default

### D7.3 Hub URL convention
- **Default:** `--hub <url>` per command, with `TAINNEL_HUB_URL` env-var
  fallback. No hard-coded default — explicit beats implicit for ops.
- Decision: ☐ accept default

### D7.4 Storage location
- **Default:** `~/.tainnel/channels/` via `FileStorage` (already shipped
  in P4). Override with `--storage-dir <path>`.
- Decision: ☐ accept default

## Implementation tasks

### SDK addition (`packages/sdk/src/wallet.ts`)

- [ ] `[agent]` Add `PrivateKeyWalletAdapter` next to `ViemWalletAdapter`
      and `BrowserWalletAdapter`.
      - Constructor: `new PrivateKeyWalletAdapter({ privateKey: Hex,
        chainId: number })`.
      - Implements `WalletAdapter` (`getAddress`, `signTypedData`,
        `signMessage`).
      - Wraps `viem`'s `privateKeyToAccount` — already a transitive dep
        of `packages/sdk/`.
      - Sized at ~30–50 LOC.
- [ ] `[agent]` Re-export `PrivateKeyWalletAdapter` from
      `packages/sdk/src/index.ts`.
- [ ] `[agent]` Tests in `packages/sdk/src/wallet.test.ts`: address
      recovery, EIP-712 signature validity (cross-checked against
      `ViemWalletAdapter` for the same key), error on missing key, error
      on malformed key.

### CLI wiring (`apps/cli/src/`)

- [ ] `[agent]` `src/lib/keystore.ts` — load private key from
      `TAINNEL_PRIVATE_KEY`; throw a friendly error if missing. Never log
      the key, never echo it back.
- [ ] `[agent]` `src/lib/client.ts` — factory that builds a
      `ChannelClient` from the loaded key + `--hub` (or `TAINNEL_HUB_URL`)
      + storage dir.
- [ ] `[agent]` `src/lib/render.ts` — `Renderer` interface with `pretty`
      and `json` implementations; selected by global `--json` flag.

#### `tainnel channel open --hub <url> --amount <usdc>`
- [ ] `[agent]` Parse `--amount` (USDC, 6 decimals) into bigint.
- [ ] `[agent]` Build `ChannelClient`, call `open()`.
- [ ] `[agent]` Render: channel id, on-chain tx hash, status.

#### `tainnel channel list`
- [ ] `[agent]` Read all locally-known channels via
      `ChannelClient.list()`.
- [ ] `[agent]` Render a table: id, status, our balance, counterparty
      balance, pending HTLCs.

#### `tainnel channel close <id> [--cooperative]`
- [ ] `[agent]` Drive `ChannelClient.close({ cooperative:
      opts.cooperative ?? true })`.
- [ ] `[agent]` Render: final balances, on-chain tx hash, finalization
      status.

#### `tainnel pay --to <address> --amount <usdc> --via <hub>`
- [ ] `[agent]` Validate `--to` (EVM address); convert `--amount` to
      bigint.
- [ ] `[agent]` Drive `ChannelClient.pay({ to, amount })` over the channel
      against `<hub>`.
- [ ] `[agent]` Render: HTLC sent, awaiting preimage, settled.

#### `tainnel hub status <url>`
- [ ] `[agent]` GET `<url>/v1/health`. Pretty-print status, version,
      open-channel count if returned.

### Documentation

- [ ] `[agent]` Update `apps/cli/README.md` with: env-var setup, install
      snippet, the v1 happy-path script (open → pay → close), JSON output
      examples for AI-agent consumers.

### Tests

- [ ] `[agent]` Unit tests for each command's argument parsing and error
      handling. Use a mock `ChannelClient` so commands can be tested
      without a live hub.
- [ ] `[agent]` E2E test in `apps/cli/src/e2e.test.ts`: spawn two
      `tainnel` subprocesses with two different keys; bring up the
      real-WS mock hub from `@tainnel/test-utils`; run open → pay → close
      end-to-end; assert final balances.

## Demo dogfood flow (the v1 happy path)

1. Operator (or AI agent) sets `TAINNEL_PRIVATE_KEY` to keypair-A and
   `TAINNEL_HUB_URL` to the hub WebSocket URL.
2. `tainnel channel open --amount 5` — opens a channel funded with 5 USDC.
3. Second process / second keypair (B) does the same.
4. From keypair-A: `tainnel pay --to <B's address> --amount 1` — payment
   routes A → hub → B, settles.
5. `tainnel channel close <id> --cooperative` from each side; final
   balances on-chain match expectation.

This entire flow is scriptable. An AI agent driving it shells out to
`tainnel` and parses `--json` output (or imports `@tainnel/sdk`
directly — both work).

## `[review]` gates

- You manually run `tainnel channel open` on Hoodi at least once before
  P10 mainnet launch. The CLI is the user-facing failure surface.
- You read `src/lib/keystore.ts`. Confirm we never log the raw key, never
  echo it back to stdout, and never write it to disk.

## Done when

- All `[ ]` boxes checked
- `pnpm --filter @tainnel/cli test` ≥ 80% lines
- E2E `open → pay → close` runs green against the mock hub
- `tainnel --help` documents every command above
- Manually tested on Hoodi by Daniel
- Branch merged with `feat(cli): wire channel open/pay/close end-to-end`
