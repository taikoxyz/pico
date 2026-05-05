# Mainnet smoke (canary) scripts

Operator-driven scripts that turn the mainnet smoke channel lifecycle into
a guided, idempotent run. Per-channel cap 100 USDC, hub liquidity ceiling
1000 USDC, three operator wallets `alice`, `bob`, `carol` under
`~/.pico/<role>/`. Tracked under
[issue #21](https://github.com/dantaik/pico/issues/21).

## Prerequisites

- The three encrypted operator key files exist:
  - `~/.pico/alice/key.enc`
  - `~/.pico/bob/key.enc`
  - `~/.pico/carol/key.enc`

  Generate via:
  ```bash
  unset PICO_PASSPHRASE
  for role in alice bob carol; do
    PICO_CONFIG_DIR="$HOME/.pico/$role" pnpm pico keys init
  done
  ```
  Use a distinct passphrase per role; record passphrases offline.
- Each operator address has been funded from the cold wallet:
  - 100 USDC (matches per-channel cap)
  - ~0.005 ETH for gas (channel open + state updates + cooperative close)
- Hub hot wallet has been funded with USDC up to but not exceeding the
  1000 USDC ceiling.
- The expected proxy owner address is known and verified. For v1 this should
  be a deployed Safe or timelock contract, not an undeployed address.
- `cast` (Foundry) and `python3` on PATH.
- The hub URL is reachable from this machine.

## Expected wall-clock time

~30 minutes interactive (with confirmation prompts between phases). Faster
with `--yes` for CI / dry runs. The dispute drill alone has a default
deadline of 5 minutes for the watchtower to win.

## Running the full flow

```bash
scripts/mainnet-smoke/run-all.sh \
  --hub https://hub.example.com \
  --hub-hot-wallet 0xHubHotWalletAddress \
  --expected-owner 0xSafeOrTimelockAddress
```

Pass `--yes` to skip phase prompts (CI / dry runs only). Set `RPC_URL`
to override the Taiko mainnet RPC default. If ownership has moved to a
timelock, also pass `--timelock 0x... --safe 0x...` so precheck verifies the
48h delay and Safe proposer/executor roles.

## Phase scripts

Each can be invoked individually (useful for re-running just one phase).

| Phase | Script | What it does |
|---|---|---|
| 00 | `00-precheck.sh` | Verifies key files, hub liveness, chainId, contract bytecode, proxy ownership, owner code, USDC allowlist, optional timelock roles, USDC + ETH balances, and the 1000 USDC hub ceiling. Exits non-zero on any failure. |
| 01 | `01-open-channels.sh` | Opens Alice + Bob channels (10 USDC default). Idempotent: skips if a role already has an open channel. |
| 02 | `02-pay.sh` | Backgrounds Bob's `pico listen`, Alice creates an invoice via Bob, Alice pays it. Asserts settle. |
| 03 | `03-cooperative-close.sh` | Cooperatively closes every open channel for Alice + Bob; records final on-chain USDC balances. |
| 04 | `04-dispute-drill.sh` | Carol opens a drill channel, exchanges one state, then submits an OLDER state via raw `cast send` (CLI gap noted below). Polls for the watchtower's penalty submission within the deadline. |
| 05 | `05-finalize.sh` | Stitches all artifacts into `docs/mainnet-e2e-test-log.md` for the launch log. |

## Logs and artifacts

Each run lands in `scripts/mainnet-smoke/log/<UTC-timestamp>/` with one
JSON file per phase plus stderr/stdout captures and Bob's listener log.
`05-finalize.sh` reads from the same dir and writes the markdown log.

When invoked from `run-all.sh`, every phase shares one log dir via
`LOG_DIR`. When you call a phase by hand, it creates its own dir unless
you pre-export `LOG_DIR`.

## Aborting safely mid-run

- If `00-precheck.sh` fails, do not proceed — fix the precondition and
  re-run from the top.
- If `01-open-channels.sh` partially opens (one role, not the other),
  close the orphan via `pico channel close <id>` from that role's
  config dir before re-running.
- If `02-pay.sh` fails after Alice's pay returns settled but Bob's
  listener missed the event, do not retry pay — investigate the listener
  log first; the payment is durable.
- If `04-dispute-drill.sh` aborts because the watchtower didn't penalize,
  stop, cooperative-close any open channels you can, write an incident
  note. **Do not** retry the drill until the root cause is understood.

## CLI gaps documented for future work

These scripts work around several CLI gaps. Each is annotated inline; the
gaps belong on a follow-up tracking ticket:

1. `pico hub status` does not surface `chainId`, contract addresses, or
   the hub's hot-wallet address. Precheck verifies via `cast` and
   requires `--hub-hot-wallet` from the operator.
2. `pico channel open` does not print the on-chain `ChannelOpened` tx
   hash. Recover via `cast logs` after the open.
3. `pico channel close` does not print the on-chain
   `ChannelClosedCooperative` tx hash. Same workaround.
4. There is no CLI command to submit `closeUnilateral` with an *older*
   state. The dispute drill drops to raw `cast send` and an inline
   `node -e` snippet that imports `@pico/sdk`'s
   `encodeChannelStateForOnChain` + `signatureToHex` from the operator's
   local sqlite DB.
5. There is no `pico watchtower status`. The drill polls the on-chain
   `channels()` struct directly (which is the right ground truth anyway).
6. The hub's keysend encryption pubkey is not exposed via any HTTP
   endpoint. If keysend is added to the drill in a future iteration the
   operator must pass `--hub-encryption-pubkey` from hub config.

## Escalation on failure

Any abort, unexpected on-chain tx, or watchtower miss → write an incident
note, page the on-call (per `docs/runbooks/security-disclosure.md`), and
consult `docs/runbooks/dispute-response.md` if there is an active dispute
window.
