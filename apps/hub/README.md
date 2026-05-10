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

Stack: Fastify, native ws plugin, SQLite (`better-sqlite3`) for development with a
Postgres adapter for production. Structured logging via `pino`, metrics via
`prom-client`. Runs in Docker via the supplied `Dockerfile` + `docker-compose.yml`.

## Run locally

```bash
cp apps/hub/.env.example apps/hub/.env
pnpm --filter @inferenceroom/pico-hub dev
```
