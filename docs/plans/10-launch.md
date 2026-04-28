# P10 — Mainnet dogfood launch

**Status:** ⚪ planning only
**Blocks:** —
**Effort:** 3–5 days of active work + 2 weeks of soak

This is the cutover. Everything before this was infrastructure; this phase moves real
USDC and creates real consequences for bugs.

**Before starting P10**, all P1–P9 sub-plans must be 🟢. No exceptions, no shortcuts.
Re-read [`docs/plans/08-e2e-and-audit.md`](./08-e2e-and-audit.md) Done-when list and
verify each box yourself.

## Decisions

### D10.1 Per-user channel cap
- **Default:** 100 USDC. Each dogfood user can hold at most one channel,
  capped at 100 USDC.
- **Tradeoff:** higher cap means a real-feeling network but a larger blast
  radius if something goes wrong. 100 USDC is enough for "buy 100 API calls
  at 1¢ each" demos and small enough that a worst-case loss won't ruin your
  weekend.
- Decision: ☐ 50 USDC ☐ 100 USDC ☐ 250 USDC

### D10.2 Initial hub liquidity
- **Default:** 1000 USDC inbound + 1000 USDC outbound capacity floor (i.e.,
  hub deposits 1000 USDC across opened channels). Caps at 1500 USDC by D9.4.
- Decision: ☐ 500 USDC ☐ 1000 USDC ☐ 2000 USDC

### D10.3 Number of dogfood users
- **Default:** 3–5 trusted people (technical friends, contributors, AI
  agents you operate). They are explicitly told this is dogfood and may
  experience bugs.
- Decision: ☐ just you ☐ 3 ☐ 5 ☐ open invite to a small Discord

### D10.4 How channels are opened on mainnet
- **Default:** users run `tainnel channel open --hub <url> --amount <n>`
  from their own machine. Hub auto-accepts up to D10.1. The deployer (cold
  wallet) does not open channels on behalf of others.
- Decision: ☐ self-serve via CLI (default) ☐ Daniel manually opens for each user

### D10.5 Soak duration
- **Default:** 14 days of observed normal operation before declaring the
  project "production ready". Soak ends successfully if every gate at the
  bottom of this file is green.
- Decision: ☐ 7 days ☐ 14 days ☐ 30 days

### D10.6 Kill criteria (when to abort)
- **Default:** any of these immediately rolls back to "all channels
  cooperative-close, hub paused":
  - Funds lost in any amount
  - Watchtower fails to penalize a known-stale state during a drill
  - More than 3 hub crashes in 24h
  - Dispute window passed with our state not posted (any reason)
- Decision: ☐ accept default ☐ stricter ☐ looser

## Pre-flight checklist (do these in order, no skipping)

### One week before launch
- [ ] `[review]` Re-read every `[review]` gate from P1–P9. Re-click them.
- [ ] `[human]` Tag the release: `git tag v0.1.0 -m 'dogfood launch candidate'`.
- [ ] `[human]` Announce internally to the dogfood crew: "we're launching
      $DATE on Taiko mainnet, here's what to expect".
- [ ] `[human]` Confirm cold wallet has ≥ 0.1 ETH (deploy gas) + D10.2 USDC
      (initial hub liquidity) + 0.1 ETH each for hub & watchtower hot wallets.
- [ ] `[agent]` Confirm `packages/protocol/src/constants.ts`
      `CONTRACT_ADDRESSES[167000]` is wired with a placeholder slot for the
      soon-to-be-deployed contract address. (The CLI reads addresses from
      `constants.ts`; no separate env file.)

### Day of: contract deployment
- [ ] `[human]` From the **cold wallet**, deploy contracts to Taiko mainnet:
      ```bash
      cd packages/contracts
      forge script script/Deploy.s.sol \
        --rpc-url taiko_mainnet \
        --broadcast \
        --verify \
        --legacy
      ```
- [ ] `[human]` Verify both contracts on Taikoscan show source code.
- [ ] `[human]` Record addresses in:
      - `packages/protocol/src/constants.ts` `CONTRACT_ADDRESSES[167000]`
      - your password manager / project tracking
- [ ] `[agent]` Update USDC token address in `constants.ts` to the canonical
      Taiko mainnet USDC.
- [ ] `[agent]` Bump version to `0.1.0` and commit.

### Day of: services rollout
- [ ] `[human]` `flyctl deploy` hub against mainnet config (set RPC URL,
      contract addresses, real USDC token). **Health check first**, then
      monitoring dashboards.
- [ ] `[human]` `flyctl deploy` watchtower against mainnet config.
- [ ] `[human]` Publish the CLI: `pnpm --filter @tainnel/cli build` and
      `pnpm pack --filter @tainnel/cli` (or `npm publish` if going public).
- [ ] `[human]` Smoke test: install `@tainnel/cli` on a fresh machine, set
      `TAINNEL_PRIVATE_KEY` and `TAINNEL_HUB_URL`, run `tainnel hub status
      $TAINNEL_HUB_URL`, confirm the hub responds with mainnet chain id.

### Day of: hub bootstrap
- [ ] `[human]` From cold wallet, send the hub's hot wallet:
      - 0.5 ETH for gas
      - D10.2 USDC for initial liquidity
- [ ] `[human]` Open one channel between **yourself** and the hub for D10.1
      USDC. This is the smoke test. Verify:
      - `ChannelOpened` event in Taikoscan
      - hub `/v1/channels` lists it
      - watchtower logs reflect the new channel under watch
- [ ] `[human]` Send 1 USDC payment to your own second address through the
      hub. Confirm settlement.

### Onboard the dogfood crew
- [ ] `[human]` Send each user the CLI install + setup snippet
      (`TAINNEL_PRIVATE_KEY`, `TAINNEL_HUB_URL`) + a 1-pager explaining:
      "run `tainnel channel open --amount <n>` up to D10.1 USDC, pay each
      other with `tainnel pay`, report bugs."
- [ ] `[human]` Confirm each onboard with a test payment.

## Soak period (D10.5 days)

- [ ] `[human]` Daily: skim Grafana dashboards. Confirm no alerts in Discord.
- [ ] `[human]` Day 3: run a dispute drill. From a test wallet on mainnet,
      open a channel, do a payment, then submit `closeUnilateral` with the
      pre-payment state. Verify the watchtower penalizes within the window.
      If it doesn't, **kill the launch** per D10.6.
- [ ] `[human]` Day 7: midpoint review. Open `docs/launch-log.md`, summarize
      issues seen.
- [ ] `[human]` Day 14: final review. Decide go/no-go on declaring 🟢.

## Done when ("dogfood production ready")

- [ ] Mainnet contracts deployed + verified
- [ ] Mainnet hub + watchtower running for ≥ 14 days
- [ ] At least 10 successful payments through the hub by users other than
      yourself
- [ ] Mainnet dispute drill succeeded
- [ ] No funds lost
- [ ] No P0 incidents (one P1 acceptable per D10.6)
- [ ] `docs/launch-log.md` summarizing soak observations
- [ ] Open issues filed for Phase 2 (DVM integration, ETH support,
      multi-watchtower, fee market)
- [ ] `ROADMAP.md` updated to "v0.1.0 dogfood live" with date

## After launch

If you want this beyond dogfood — public launch with real users — Phase 2
adds: external audit, bug bounty, ETH alongside USDC, DVM payment flow demo,
multi-hub failover, formal threat-model writeup. None of that is in this
roadmap. File new sub-plans when you're ready.
