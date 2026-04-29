# @tainnel/cli — agent runtime

The agent runtime for tainnel. Open and close payment channels on Taiko, send and
receive USDC payments via invoice or keysend, and run a long-lived listener that
settles inbound HTLCs as they arrive.

## Quickstart (env-var key, fastest path)

```bash
export TAINNEL_PRIVATE_KEY=0x…   # 32-byte hex; warn-printed at startup
pnpm install
pnpm tainnel hello

# Pattern A — invoice flow
INV=$(pnpm tainnel invoice create --amount 50000 --memo "service foo")
pnpm tainnel pay --invoice "$INV" --via ws://hub.example.com:9050 --json

# Pattern B — keysend
pnpm tainnel pay --keysend --to 0xRecipient --amount 50000 \
  --recipient-pubkey 0x… --via ws://hub.example.com:9050 --json

# Receive (long-lived)
pnpm tainnel listen --hub ws://hub.example.com:9050
```

## Persistent encrypted key

```bash
pnpm tainnel keys init                    # generate + passphrase-encrypt
pnpm tainnel keys show                    # print address only
pnpm tainnel keys import --from 0x…       # import an existing key
pnpm tainnel keys show --reveal-private   # passphrase-prompted
```

The CLI resolves the signing key in this order:

1. `--private-key <hex>` flag (warns to stderr)
2. `TAINNEL_PRIVATE_KEY` env var (warns to stderr)
3. `--key-file <path>` argument
4. `$XDG_CONFIG_HOME/tainnel/key.enc` (default location)

The first two are intended for test/CI use. The encrypted file format is
`scrypt(N=2^17,r=8,p=1)` + `xsalsa20-poly1305` (libsodium-compatible) sealed
inside a small JSON envelope.

## Commands

```
tainnel hello
tainnel keys init|import|show
tainnel channel open --hub <addr> --amount <usdc> [--rpc <url>] [--token <addr>]
tainnel channel list [--json]
tainnel channel close <id> [--cooperative|--unilateral] [--via <ws-url>]
tainnel invoice create --amount <usdc> [--memo <s>] [--expiry <s>] [--hub-hint <url>]
tainnel invoice list [--paid|--unpaid] [--json]
tainnel invoice show <paymentHash> [--reveal-preimage]
tainnel pay --invoice <env> [--via <ws-url>] [--json]
tainnel pay --keysend --to <addr> --amount <usdc> --recipient-pubkey <hex> [--memo <s>] [--via <ws-url>] [--json]
tainnel listen [--hub <ws-url>] [--channel <id>...] [--log-format pretty|json]
tainnel hub status <http-url>
tainnel dev anvil-fork [--fork-url <rpc>] [--fork-block <n>] [--port <n>]
tainnel dev mock-hub [--port <n>]
```

## Tests

```bash
pnpm --filter @tainnel/cli test --coverage
```

Coverage thresholds: 70% lines / 60% branches / 70% functions / 70% statements.

## Demo (one terminal)

```bash
# Terminal 1 — start a mock hub
pnpm tainnel dev mock-hub --port 9050

# Terminal 2 — Bob listens (config dir A)
TAINNEL_PRIVATE_KEY=0x…b0b TAINNEL_CONFIG_DIR=/tmp/bob \
  pnpm tainnel listen --hub ws://127.0.0.1:9050

# Terminal 3 — Bob issues an invoice
INV=$(TAINNEL_PRIVATE_KEY=0x…b0b TAINNEL_CONFIG_DIR=/tmp/bob \
  pnpm tainnel invoice create --amount 50000 --memo "demo")

# Terminal 4 — Alice pays
TAINNEL_PRIVATE_KEY=0x…a11c TAINNEL_CONFIG_DIR=/tmp/alice \
  pnpm tainnel pay --invoice "$INV" --via ws://127.0.0.1:9050 --json
```

The integration test at `test/integration/pay-listen.integration.test.ts` runs
this whole flow in-process against the test-utils mock hub.
