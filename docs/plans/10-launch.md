# P10 — Mainnet real-money E2E test readiness

**Status:** 🟡 in progress (operator-wallet decisions locked; gating items
tracked in [`../launch-checklist.md`](../launch-checklist.md))
**Blocks:** P9
**Effort:** 1–2 days of active execution after P1–P9 are green

This is the first controlled Taiko mainnet run with real USDC. It is not a public
launch, not a production readiness declaration, and not a speed/scale exercise. The
goal is to prove one low-value end-to-end flow across the deployed contracts, hub,
watchtower, SDK, and CLI, with enough monitoring and runbooks in place to stop safely
if anything behaves incorrectly.

**Before starting P10**, all P1–P9 sub-plans must be 🟢. No exceptions. Re-read
[`docs/plans/08-e2e-and-audit.md`](./08-e2e-and-audit.md) and verify each correctness
and review gate yourself.

## Decisions

### D10.1 Test channel cap
- **Default:** 100 USDC maximum in any single test channel.
- **Tradeoff:** higher caps make the test feel closer to normal use but increase the
  blast radius. 100 USDC is enough to exercise routing and dispute flows while keeping
  the first real-money run deliberately small.
- Decision: ☐ 50 USDC ☑ 100 USDC ☐ 250 USDC

### D10.2 Initial hub liquidity ceiling
- **Default:** fund the hub with enough USDC for the planned test channels, capped at
  1000 USDC total. Do not exceed the P9 hot-wallet ceiling.
- Decision: ☐ 500 USDC ☑ 1000 USDC ☐ 2000 USDC

### D10.3 Test participants
- **Default:** two wallets/agents you control: Alice sends, Bob receives via
  `tainnel listen`. Add trusted external operators only after the single-operator flow
  passes.
- **Decision:** 3 claude-generated operator wallets (`alice`, `bob`, `carol`) on this
  machine. Each wallet has its own encrypted key under `~/.tainnel/<role>/key.enc`
  (scrypt + xsalsa20-poly1305, perms 0600). Claude has the passphrases; user funds
  the addresses. Roles: Alice and Bob run the controlled mainnet flow (sender +
  receiver); Carol owns the dispute drill on a dedicated channel so a stale-state
  close cannot pollute the Alice/Bob channels. 3 is the lower bound of the original
  3–5 range — smaller blast radius for the first real-money run; scale to 5 by
  repeating the wallet-generation loop with new role names if needed.
- **Tradeoff:** keys live on one machine. If this machine is compromised, all 3
  operator wallets are compromised. Acceptable given each wallet is capped at
  100 USDC (D10.1) and the hub at 1000 USDC (D10.2).
- Decision: ☐ just you ☐ you + one trusted operator ☑ 3–5 trusted operators

### D10.4 How channels are opened
- **Default:** self-serve from the CLI with `tainnel channel open --hub <url>
  --amount <usdc>`. The cold wallet does not open user channels on behalf of others.
- Decision: ☑ self-serve via CLI ☐ manually open for each participant

### D10.5 Abort criteria
- **Default:** immediately stop, cooperative-close all open channels if possible, and
  write an incident note if any of these happen:
  - Funds lost in any amount
  - Watchtower fails to penalize the deliberate stale-state drill
  - Hub or watchtower crashes during a payment or dispute
  - Dispute window passes without the latest state posted
  - Any mainnet transaction uses an unexpected contract or token address
- Decision: ☑ accept default ☐ stricter ☐ looser

## Pre-flight checklist

- [ ] `[review]` Confirm P1–P9 are green in `ROADMAP.md`.
- [ ] `[review]` Re-read every P2/P8 security review gate and confirm nothing is
      still unchecked.
- [ ] `[human]` Confirm `packages/protocol/src/constants.ts` records the Taiko
      mainnet PaymentChannel, Adjudicator, and USDC addresses you intend to use.
- [ ] `[human]` Confirm owner keys have been rotated away from any key that touched
      an LLM context.
- [ ] `[human]` Confirm the cold wallet, hub hot wallet, and watchtower hot wallet
      have only the ETH/USDC needed for the test caps.
- [ ] `[human]` Confirm hub and watchtower are deployed from the intended commit,
      in separate regions, with monitoring and alert delivery already tested.
- [ ] `[human]` Confirm `docs/runbooks/` covers hub-down, watchtower-down, dispute
      incident, key compromise, and backup restore.
- [ ] `[human]` Confirm SECURITY.md reflects monitored inbox, real PGP key, and
      paging rotation tested via dry-run drill (see
      `docs/runbooks/security-disclosure.md`).

### Operator wallet generation (D10.3)

Run on the same machine that will execute the test. The CLI's `TAINNEL_CONFIG_DIR`
env var overrides the default `~/.config/tainnel/` path
(`apps/cli/src/runtime/config.ts:4-8`) so each operator persona gets its own config
dir, encrypted key file, and channel db.

- [ ] `[agent]` Generate three encrypted operator keys under `~/.tainnel/`:
      ```bash
      unset TAINNEL_PASSPHRASE   # otherwise keys init reuses one passphrase for all
      mkdir -p ~/.tainnel
      for role in alice bob carol; do
        TAINNEL_CONFIG_DIR="$HOME/.tainnel/$role" pnpm tainnel keys init
      done
      ```
      Use a distinct passphrase per role; record passphrases offline (paper or
      password manager). Each command prints `address: 0x…` and writes
      `~/.tainnel/<role>/key.enc` with mode 0600.
- [ ] `[agent]` Print all three addresses for funding:
      ```bash
      for role in alice bob carol; do
        echo "== $role =="
        TAINNEL_CONFIG_DIR="$HOME/.tainnel/$role" pnpm tainnel keys show
      done
      ```
- [ ] `[human]` Fund each operator address from the cold wallet on Taiko mainnet:
      - 100 USDC (matches D10.1 per-channel cap)
      - ~0.005 ETH for gas (channel open + state updates + cooperative close;
        bridge from L1 if needed)
- [ ] `[human]` Fund the hub hot wallet with USDC up to but not exceeding the
      1000 USDC ceiling from D10.2. Confirm against the hub hot wallet address
      from P9 on Taikoscan before transferring.
- [ ] `[human]` Take an offline backup of `~/.tainnel/` (encrypted USB, sealed
      envelope, or external password-manager attachment). The `key.enc` files are
      passphrase-encrypted, but disk loss + passphrase loss is unrecoverable.

## First controlled mainnet flow

- [ ] `[human]` From a clean checkout or published CLI, run:
      ```bash
      tainnel hub status <mainnet hub URL>
      ```
      Confirm the response reports Taiko mainnet and the expected contract addresses.
- [ ] `[human]` Alice opens a low-value channel to the hub:
      ```bash
      tainnel channel open --hub <mainnet hub URL> --amount <small test amount>
      ```
      Record the channel id and `ChannelOpened` transaction.
- [ ] `[human]` Bob opens a low-value channel to the same hub and starts:
      ```bash
      tainnel listen --hub <mainnet hub URL> --log-format json
      ```
- [ ] `[human]` Bob creates an invoice:
      ```bash
      tainnel invoice create --amount <small payment amount> --memo "mainnet e2e test"
      ```
- [ ] `[human]` Alice pays the invoice:
      ```bash
      tainnel pay --invoice "$INVOICE" --via <mainnet hub URL> --json
      ```
      Confirm Alice receives the preimage receipt, Bob settles the inbound HTLC, and
      both local channel states advance.
- [ ] `[human]` Cooperative-close both channels and confirm final balances on
      Taikoscan match the expected post-payment balances.

## Dispute drill

- [ ] `[human]` Carol opens a fresh low-value drill channel to the hub (separate from
      the Alice/Bob channels above):
      ```bash
      TAINNEL_CONFIG_DIR="$HOME/.tainnel/carol" \
        tainnel channel open --hub <mainnet hub URL> --amount <small drill amount>
      ```
- [ ] `[human]` Carol and the hub exchange at least one signed state update so there
      is an older state and a newer state.
- [ ] `[human]` Carol submits `closeUnilateral` with the older signed state.
- [ ] `[human]` Confirm the watchtower observes the stale close and submits the newer
      state before the dispute window closes.
- [ ] `[human]` Finalize and confirm the hub (the honest party) receives the expected
      funds; Carol's stale-state attempt is penalized.
- [ ] `[human]` If any step misses the expected state transition, apply D10.5.

## Done when

- [ ] One low-value mainnet channel open succeeds against the expected deployed
      contracts.
- [ ] One invoice-mode agent-to-agent payment succeeds with real USDC.
- [ ] Receiver-side `tainnel listen` reveals the correct preimage and persists the
      settled state.
- [ ] Cooperative close finalizes with expected balances.
- [ ] Mainnet stale-state dispute drill succeeds within the dispute window.
- [ ] Monitoring records the payment/dispute flow and no unexpected alerts fire.
- [ ] `docs/mainnet-e2e-test-log.md` is written with dates, addresses, tx hashes,
      channel ids, observed logs, and follow-up issues.
- [ ] `ROADMAP.md` is updated with the real-money E2E test result.

## After the first test

If the first controlled real-money test is clean, file new follow-up plans for the
next scope increase. Likely candidates:

- Longer private soak with trusted operators.
- React wallet UI for humans.
- ERC-8004 agent identity.
- EIP-7702 / 4337 smart-account delegation after Taiko support is verified.
- TEE / KMS Signer backends.
- External audit or outside reviewer.
- ETH support.
- DVM payment flow using the existing `dvm-adapter` scaffold.
- Multi-hub failover; multi-hop routing only if a real need emerges.

The project does **not** intend to add MCP or x402 integrations in-tree. If those
ecosystems want to consume the system, they can write a thin external adapter on top
of `apps/cli` or the SDK.
