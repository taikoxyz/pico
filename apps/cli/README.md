# @pico/cli — agent runtime

The agent runtime for pico. Open and close payment channels on Taiko, send and
receive USDC payments via invoice or keysend, and run a long-lived listener that
settles inbound HTLCs as they arrive.

## Quickstart (encrypted key, recommended)

```bash
pnpm install
pnpm pico keys init                    # generate + passphrase-encrypt
pnpm pico hello

# Pattern A — invoice flow
INV=$(pnpm pico invoice create --amount 50000 --memo "service foo")
pnpm pico pay --invoice "$INV" --via ws://hub.example.com:9050 --json

# Pattern B — keysend
pnpm pico pay --keysend --to 0xRecipient --amount 50000 \
  --recipient-pubkey 0x… --via ws://hub.example.com:9050 --json

# Receive (long-lived)
pnpm pico listen --hub ws://hub.example.com:9050
```

## Key management

```bash
pnpm pico keys init
pnpm pico keys show                    # print address only
pnpm pico keys import --from 0x…       # import an existing key
pnpm pico keys show --reveal-private   # passphrase-prompted
```

The default encrypted key path is `$XDG_CONFIG_HOME/pico/key.enc` (or
`~/.config/pico/key.enc` when `XDG_CONFIG_HOME` is unset). The file format is
`scrypt(N=2^17,r=8,p=1)` + `xsalsa20-poly1305` (libsodium-compatible) sealed
inside a small JSON envelope.

## Test/CI shortcut (raw keys, not recommended for operators)

```bash
export PICO_PRIVATE_KEY=0x…   # 32-byte hex; warns to stderr
pnpm install
pnpm pico hello
```

The CLI resolves the signing key in this order:

1. `--private-key <hex>` flag (warns to stderr)
2. `PICO_PRIVATE_KEY` env var (warns to stderr)
3. `--key-file <path>` argument
4. `$XDG_CONFIG_HOME/pico/key.enc` (default location)

The first two are intended for test/CI use. Production/operator workflows
should prefer encrypted key files.

## Commands

```
pico hello
pico keys init|import|show
pico channel open --hub <addr> --amount <usdc> [--rpc <url>] [--token <addr>]
pico channel list [--json]
pico channel close <id> [--cooperative|--unilateral] [--via <ws-url>]
pico invoice create --amount <usdc> [--memo <s>] [--expiry <s>] [--hub-hint <url>]
pico invoice list [--paid|--unpaid] [--json]
pico invoice show <paymentHash> [--reveal-preimage]
pico pay --invoice <env> [--via <ws-url>] [--json]
pico pay --keysend --to <addr> --amount <usdc> --recipient-pubkey <hex> [--memo <s>] [--via <ws-url>] [--json]
pico listen [--hub <ws-url>] [--channel <id>...] [--log-format pretty|json]
pico hub status <http-url>
pico dev anvil-fork [--fork-url <rpc>] [--fork-block <n>] [--port <n>]
pico dev mock-hub [--port <n>]
```

## Tests

```bash
pnpm --filter @pico/cli test --coverage
```

Coverage thresholds: 70% lines / 60% branches / 70% functions / 70% statements.

## Demo (test keys; one terminal)

```bash
# Terminal 1 — start a mock hub
pnpm pico dev mock-hub --port 9050

# Terminal 2 — Bob listens (config dir A)
PICO_PRIVATE_KEY=0x…b0b PICO_CONFIG_DIR=/tmp/bob \
  pnpm pico listen --hub ws://127.0.0.1:9050

# Terminal 3 — Bob issues an invoice
INV=$(PICO_PRIVATE_KEY=0x…b0b PICO_CONFIG_DIR=/tmp/bob \
  pnpm pico invoice create --amount 50000 --memo "demo")

# Terminal 4 — Alice pays
PICO_PRIVATE_KEY=0x…a11c PICO_CONFIG_DIR=/tmp/alice \
  pnpm pico pay --invoice "$INV" --via ws://127.0.0.1:9050 --json
```

The integration test at `test/integration/pay-listen.integration.test.ts` runs
this whole flow in-process against the test-utils mock hub.
