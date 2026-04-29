# `@tainnel/cli`

The `tainnel` developer/operator CLI — open and close payment channels, send
payments, and query hub status. v1's user-facing surface (no browser wallet
UI). AI agents can either shell out to `tainnel` and parse `--json` output, or
import `@tainnel/sdk` directly.

Design and decision log: [`docs/plans/07-cli.md`](../../docs/plans/07-cli.md).

## Install + build

```bash
pnpm install
pnpm --filter @tainnel/cli build
pnpm tainnel --help          # invokes the workspace alias
```

After `pnpm build`, the binary is wired as `pnpm tainnel <cmd>` from the repo
root. For local development (no rebuild needed) use `pnpm --filter @tainnel/cli
dev <cmd>` (runs the TS source via `tsx`).

## Environment

| Variable                  | Required             | Description                                                                       |
|---------------------------|----------------------|-----------------------------------------------------------------------------------|
| `TAINNEL_PRIVATE_KEY`     | yes                  | Hex-encoded private key (`0x` + 64 hex chars). Never logged or echoed.            |
| `TAINNEL_RPC_URL`         | for `viem` chain mode (default) | RPC endpoint for the chain. Defaults to `https://rpc.taiko.xyz` for mainnet, `https://rpc.hoodi.taiko.xyz` for Hoodi. |
| `TAINNEL_HUB_URL`         | optional             | Convenience default for `--hub` / `--via`. Per-command flags still override.       |
| `TAINNEL_STORAGE_DIR`     | optional             | Override the channel storage directory. Default `~/.tainnel/channels`.            |
| `TAINNEL_CHAIN_MODE`      | optional             | `viem` (default; real on-chain) or `memory` (TEST-ONLY; for the E2E test).        |
| `TAINNEL_CONTRACT_ADDRESS`| optional             | Override the PaymentChannel proxy address (useful for local anvil + Hoodi).       |
| `TAINNEL_TOKEN_ADDRESS`   | optional             | Override the USDC token address (useful for local anvil + Hoodi).                 |
| `TAINNEL_HUB_ADDRESS`     | optional             | Skip the hub `/health` round-trip and pin the hub address.                        |
| `TAINNEL_HUB_CHAIN_ID`    | optional             | Required alongside `TAINNEL_HUB_ADDRESS` if you skip `/health`.                   |

**Security:** do not paste your private key directly into a shell — it ends up
in shell history. Use a process manager / secret store that injects
`TAINNEL_PRIVATE_KEY` at runtime (1Password CLI, AWS Parameter Store, Vault,
direnv with an out-of-history `.envrc`, etc.).

## Commands

```bash
pnpm tainnel hello                                            # smoke check; prints all package versions

pnpm tainnel channel open  --hub <url> --amount 5             # open with 5 USDC
pnpm tainnel channel list  [--hub <url>] [--storage-dir <p>]
pnpm tainnel channel close <id> --hub <url> [--cooperative|--unilateral]

pnpm tainnel pay --to <address> --amount <usdc> --via <hub-url>

pnpm tainnel hub status <url>
```

`--hub <url>` accepts either a WebSocket URL (`ws://`/`wss://`) or an HTTP base
(`http://`/`https://`); the CLI derives the sibling. Examples:
`--hub http://localhost:3030` and `--hub ws://localhost:3030/v1/ws` both work.

A global `--json` flag switches every command to machine-readable JSON output
(one JSON object per line, bigints as decimal strings).

## Happy-path script (the v1 dogfood flow)

```bash
# Pre-reqs: TAINNEL_PRIVATE_KEY exported as keypair-A
export TAINNEL_PRIVATE_KEY=0x...
export TAINNEL_RPC_URL=https://rpc.taiko.xyz

# 1. Open a 5-USDC channel with the hub
pnpm tainnel channel open --hub https://hub.tainnel.xyz --amount 5

# (in a second shell, with keypair-B)
pnpm tainnel channel open --hub https://hub.tainnel.xyz --amount 5

# 2. From keypair-A: pay 1 USDC to keypair-B's address
pnpm tainnel pay --to 0x<bob-address> --amount 1 --via https://hub.tainnel.xyz

# 3. From either side: cooperatively close
pnpm tainnel channel close <channel-id> --hub https://hub.tainnel.xyz
```

### JSON output (for AI agents / scripts)

```bash
$ pnpm tainnel --json channel open --hub ws://localhost:3030 --amount 5
{"kind":"channel.opened","channelId":"0x...","counterparty":"0x...","amount":"5000000","status":"open","txHash":"0x..."}

$ pnpm tainnel --json pay --to 0x... --amount 1 --via ws://localhost:3030
{"kind":"payment.sent","channelId":"0x...","preimage":"0x...","htlcId":"0x...","to":"0x...","settledAtMs":1730000000000}

$ pnpm tainnel --json hub status http://localhost:3030
{"kind":"hub.status","status":"ok","dbReady":true,"chainReady":true,"address":"0x...","chainId":167000,"version":"0.1.0","url":"http://localhost:3030"}
```

## Storage layout

Channel state lives in `~/.tainnel/channels/<channel-id>.json` (or
`$TAINNEL_STORAGE_DIR/channels/<channel-id>.json`). Files are atomic-write
(temp + rename) so a crash mid-write doesn't corrupt them.

Back this directory up — it contains your only copy of the latest signed
channel states. Lose them and you can no longer challenge a fraudulent close.

## Testing

```bash
pnpm --filter @tainnel/cli test          # unit + E2E vs mock hub (≥ 80% coverage)
pnpm --filter @tainnel/cli typecheck
```

The E2E test (`src/e2e.test.ts`) spawns two `tainnel` subprocesses with two
different keys, brings up the real-WS mock hub from `@tainnel/test-utils`, and
runs `open → pay → close` end-to-end with `TAINNEL_CHAIN_MODE=memory`.

## Out of scope (deferred)

- `tainnel dev anvil-fork` — local Taiko fork helper. The stub still throws.
- Encrypted JSON keystore (`--keystore` flag). Add iff someone asks (per
  D7.1 fallback in the plan).
