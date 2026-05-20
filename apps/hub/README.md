# @inferenceroom/pico-hub

Long-running service that operates as a 1-hop payment-channel hub on Taiko. Responsible
for: maintaining the channel pool, routing HTLCs between an inbound and outbound side,
tracking liquidity per channel, applying a pluggable fee policy, watching the chain for
disputes, and exposing REST + WebSocket APIs to clients.

Implements protocol-spec.md §8 (inbound liquidity / `topUp`):

- `topup-policy.ts` — pure admission evaluator (per-counterparty cap,
  hot-wallet headroom, per-channel max).
- `topup-handler.ts` — offer lifecycle (proposed → accepted → submitted →
  confirmed | rejected | expired). Hot-wallet commitments serialized via
  `KeyedMutex<'hot-wallet'>`.
- `auto-recycle.ts` — when a topped-up channel closes, the recovered USDC is
  reused for the next queued offer (§8.8).
- `chain-watcher.ts` — observes `ChannelOpened` (triggers
  `evaluateNewChannel`), `ToppedUp` (confirms post-topUp state), and
  `ChannelClosedCooperative` / `ChannelFinalized` (triggers auto-recycle).
- `auto-close.ts` — periodically reclaims liquidity from dormant channels. A
  channel the hub is a party to that has seen no payment (no new co-signed
  state) for `HUB_AUTO_CLOSE_AFTER_MS` (default 24h) is closed unilaterally by
  posting the latest co-signed state on-chain (`closeUnilateral`, or
  `closeUnilateralFromOpen` for never-used channels), then finalized once the
  on-chain dispute window elapses. Enabled by default; disable with
  `HUB_AUTO_CLOSE_ENABLED=false`. Sweep cadence is
  `HUB_AUTO_CLOSE_CHECK_INTERVAL_MS` (default 5m).

## REST endpoints (operator-gated where noted)

- `GET /v1/health` — DB + chain liveness, hub version, channel count.
- `GET /v1/info` — hub signing address, chain id, contract addresses, fee policy inputs.
- `GET /v1/fee-policy` — current hub fee (bps + flat) and the gross-up formula.
- `GET /v1/stats` — channel breakdown by status and lifetime payment/USDC counters.
- `GET /v1/channels` *(operator)* — all channels the hub knows about.
- `GET /v1/channels/closures` *(operator)* — auto-close visibility:
  `autoClose` settings, `upcoming` (open channels with idle timing and whether
  they're eligible for auto-close), and `closed` (channels already closing or
  closed).
- `GET /v1/payments/recent` *(operator)* — the last 100 payments across channels.
- `POST /v1/channels/open` *(operator)* — register a channel out-of-band.

Stack: Fastify, native ws plugin, SQLite (`better-sqlite3`) for development with a
Postgres adapter for production. Structured logging via `pino`, metrics via
`prom-client`. Runs in Docker via the supplied `Dockerfile` + `docker-compose.yml`.

## Run locally

```bash
cp apps/hub/.env.example apps/hub/.env
pnpm --filter @inferenceroom/pico-hub dev
```
