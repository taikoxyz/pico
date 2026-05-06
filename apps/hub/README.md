# @inferenceroom/pico-hub

Long-running service that operates as a 1-hop payment-channel hub on Taiko. Responsible
for: maintaining the channel pool, routing HTLCs between an inbound and outbound side,
tracking liquidity per channel, applying a pluggable fee policy, watching the chain for
disputes, and exposing REST + WebSocket APIs to clients.

Stack: Fastify, native ws plugin, SQLite (`better-sqlite3`) for development with a
Postgres adapter for production. Structured logging via `pino`, metrics via
`prom-client`. Runs in Docker via the supplied `Dockerfile` + `docker-compose.yml`.

## Run locally

```bash
cp apps/hub/.env.example apps/hub/.env
pnpm --filter @inferenceroom/pico-hub dev
```
