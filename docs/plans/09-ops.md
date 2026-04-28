# P9 — Ops & infra

**Status:** ⚪ planning only — `Dockerfile` and `docker-compose.yml` exist for
the hub, nothing for the watchtower, no production deployment, no monitoring
**Blocks:** P10
**Effort:** 4–6 days, mostly your decisions and account creation

## What this phase produces

By the end of P9 you have: a hub running 24/7 in production-grade infra
(but not yet handling real money), a watchtower running on **separate** infra
in a **different region**, a Grafana dashboard you can show on a meeting, and
a Discord channel that pings you when anything is wrong.

P10 is the final cutover; P9 is everything you have to do to be ready for it.

## Decisions

### D9.1 Hosting platform
- **Default:** **Fly.io** for both hub and watchtower
- **Tradeoff:** Fly.io has volumes (sqlite-friendly), regions (separate hub
  vs watchtower), simple WireGuard for private communication if you want it.
  Free tier covers the hub-sized workload.
- Alternatives: Railway (similar, slightly less networking control), Hetzner
  Cloud (cheap, more setup), self-host on a Raspberry Pi (don't).
- Decision: ☐ Fly.io ☐ Railway ☐ Hetzner ☐ AWS/GCP

### D9.2 Watchtower placement (CRITICAL)
- **Default:** different Fly.io app, different region, different machine size
  from the hub. Same Fly.io org is fine.
- **Why this matters:** if the hub host goes down (region outage, account
  suspension, key compromise), the watchtower must still respond before the
  dispute window closes. Co-located = single point of failure.
- Decision: ☐ separate app, separate region (default) ☐ separate org too
  (paranoid, recommended if the org is a personal account)

### D9.3 Domain + TLS
- **Default:** Fly.io's default `*.fly.dev` for v1. Bring a real domain in
  Phase 2 once stable.
- Decision: ☐ Fly.io subdomain ☐ custom domain
- If custom: domain registrar of choice, DNS at Cloudflare, Fly TLS auto-
  provisioned. Record domain in the hub's deploy config / `apps/hub/fly.toml`.

### D9.4 Hub key management
- **Default:** hot wallet (private key) stored as Fly.io secret on the hub
  machine. Maximum balance enforced at the application layer:
  - **Floor**: 0.5 ETH for gas (auto-refill from cold wallet via runbook)
  - **Ceiling**: 1500 USDC liquidity (sweeps to cold address above this)
- Decision: ☐ accept default ☐ remote signer (overkill for v1)

### D9.5 Backup strategy
- **Default:** [litestream](https://litestream.io/) replicating the hub's
  sqlite DB to **Cloudflare R2** every 10s. Point-in-time restore retained
  for 7 days.
- Decision: ☐ litestream → R2 ☐ litestream → S3 ☐ no backup (don't)

### D9.6 Monitoring stack
- **Default:** **Grafana Cloud free tier** (Prometheus push, Loki for logs).
  10k series + 50GB logs is plenty for one hub.
- Decision: ☐ Grafana Cloud ☐ self-host ☐ skip (not for production)

### D9.7 Alert destination
- **Default:** **Discord webhook** to a private channel. Cheap, async-friendly,
  works on phone.
- **Tradeoff:** Discord has no on-call rotation, no escalation. Fine for solo
  dogfood; replace with PagerDuty in Phase 2 if scope grows.
- Decision: ☐ Discord ☐ Slack ☐ PagerDuty ☐ email

### D9.8 Cold wallet
- **Default:** a hardware wallet you control. Holds the bulk of hub liquidity;
  receives sweeps from hot wallet. Deploys contracts in P10 so the deployer
  address is the cold wallet's.
- Decision: ☐ Ledger/Trezor ☐ Gnosis Safe (overkill solo) ☐ same hot wallet
  as the hub (don't)

## Implementation tasks

### Hub deployment
- [ ] `[human]` Create Fly.io account if needed; `flyctl auth login`.
- [ ] `[human]` Buy domain (if D9.3 = custom). Configure DNS at registrar.
- [ ] `[agent]` `apps/hub/fly.toml` with: app name, region (e.g., `iad`),
      one volume `hub_data` mounted at `/repo/apps/hub/data`, exposed ports
      3030 (public, TLS) and 9090 (private metrics).
- [ ] `[agent]` Update `apps/hub/Dockerfile` to copy `litestream` binary in;
      add `entrypoint.sh` that `litestream replicate` in the background and
      then `node dist/server.js`.
- [ ] `[human]` Set Fly.io secrets:
      ```
      flyctl secrets set HUB_PRIVATE_KEY=0x... \
        RPC_URL=https://rpc.taiko.xyz \
        LITESTREAM_R2_ACCESS_KEY=... \
        LITESTREAM_R2_SECRET_KEY=...
      ```
- [ ] `[human]` `flyctl deploy` from `apps/hub/`. Confirm `/health` returns 200.
- [ ] `[human]` Verify litestream is replicating: `flyctl logs | grep litestream`.

### Watchtower deployment
- [ ] `[agent]` `apps/watchtower/Dockerfile` (mirror the hub's pattern).
- [ ] `[agent]` `apps/watchtower/fly.toml` — **different region** (e.g., `fra`
      if hub is `iad`).
- [ ] `[human]` `flyctl secrets set WATCHTOWER_PRIVATE_KEY=...` (different
      address from the hub key — separate hot wallet).
- [ ] `[human]` `flyctl deploy` from `apps/watchtower/`. Confirm `/health`.
- [ ] `[human]` Fund the watchtower address with 0.1 ETH on the chain.
- [ ] `[human]` Verify the watchtower is following events: tail logs while
      opening a channel; you should see `ChannelOpened` flow through.

### Monitoring
- [ ] `[human]` Sign up for Grafana Cloud free tier.
- [ ] `[agent]` Grafana Agent or `prometheus.remote_write` config baked into
      hub + watchtower images. Push metrics to GC's Prometheus endpoint.
- [ ] `[agent]` Push structured logs (pino → JSON) to Loki via Grafana Agent.
- [ ] `[agent]` `infra/grafana/dashboards/hub.json` — basic dashboard:
      payments rate, in-flight HTLCs, channels by status, hub balance, RPC
      health.
- [ ] `[agent]` `infra/grafana/dashboards/watchtower.json` — RPC up,
      channels watched, time-since-last-event, penalties submitted.
- [ ] `[agent]` Import dashboards into Grafana Cloud (one-time manual import or
      via `grafonnet`).

### Alerts
- [ ] `[human]` Create a private Discord channel; `Edit channel → Integrations
      → Webhooks → New`. Copy URL.
- [ ] `[human]` Configure Grafana Cloud Alerting: Discord contact point with
      that webhook.
- [ ] `[agent]` Define alerts:
      - `tainnel_watchtower_rpc_up == 0 for 5m` → page (the only fund-loss
        risk if both this and the hub are down)
      - `tainnel_hub_disputes_total > 0` → page (any dispute is interesting)
      - `tainnel_hub_inbound_liquidity_usdc < 100 USDC` → warn
      - `health 5xx > 0 for 2m` → warn
      - `litestream replication lag > 60s` → warn
- [ ] `[human]` Trigger a test alert: stop the watchtower for 6 minutes,
      confirm Discord buzzes.

### Sweeper job
- [ ] `[agent]` `apps/hub/src/sweeper.ts` — a daily cron (`node-cron`) that
      checks hub USDC balance; if > ceiling, transfers excess to the cold
      wallet address.
- [ ] `[agent]` Same shape for ETH gas balance — alert (don't auto-transfer)
      if below floor.
- [ ] `[human]` Set `COLD_WALLET_ADDRESS` as a Fly.io secret.

### Runbooks (write these now, before you need them)
- [ ] `[agent]` `docs/runbooks/hub-down.md`: how to restart the hub, restore
      from litestream, hand off channels to a new hub address (manual for v1).
- [ ] `[agent]` `docs/runbooks/watchtower-down.md`: how to restart, how to
      verify it caught up on missed events, what to do if a dispute window is
      mid-flight when it crashes.
- [ ] `[agent]` `docs/runbooks/dispute-incident.md`: when an alert fires, what
      to investigate, how to reproduce the offending state, when to call it.
- [ ] `[agent]` `docs/runbooks/key-compromise.md`: if the hub or watchtower
      key is exposed, how to (a) immediately publish-and-finalize all open
      channels with cooperative-close requests, (b) rotate the address.
- [ ] `[agent]` `docs/runbooks/restore-from-backup.md`: litestream restore
      step-by-step.
- [ ] `[human]` Read all runbooks. Edit anything that doesn't match your
      operational style.

## `[review]` gates

- You verify the watchtower is on different infra from the hub. Open both
  Fly.io dashboards in adjacent tabs and confirm different regions.
- You verify the cold wallet's address matches what's set in `COLD_WALLET_ADDRESS`.
- You walk through the `key-compromise.md` runbook on Hoodi as a fire drill.

## Done when

- Hub running on Hoodi production infra for ≥ 24h with no manual intervention
- Watchtower running on separate infra, observed catching at least one
  on-chain event end-to-end
- Grafana dashboard populated; alert test fired and received in Discord
- Litestream backup tested: restore an old snapshot to a fresh volume and the
  hub boots from it cleanly
- All five runbooks written and read
- Branch merged with `feat(ops): production infra, monitoring, runbooks`
