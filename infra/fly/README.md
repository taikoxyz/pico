# Pico Fly.io deployment

Production manifests for the hub and watchtower. Single instance per service,
single region per service (hub: `iad`, watchtower: `lhr`), persistent volume
on each, litestream backup configured as a Fly process for both services.

## Layout

```
infra/fly/
├── README.md                    This file.
├── hub/
│   ├── fly.toml                 Hub manifest (app + litestream processes).
│   └── litestream.yml           Litestream replication config (uses Fly secrets).
├── watchtower/
│   ├── fly.toml                 Watchtower manifest (app + litestream processes).
│   └── litestream.yml           Litestream replication config (uses Fly secrets).
└── secrets-bootstrap.sh         Idempotent .env → Fly secrets bootstrap.
```

The Fly deploy GitHub Action lives at `.github/workflows/fly-deploy.yml`.

## Prerequisites

- `flyctl` ≥ v0.1.115 (the `[[files]]` directive used by `hub/fly.toml`
  requires recent flyctl; check with `flyctl version`).
- A Fly account with billing enabled.
- An R2 (or S3-compatible) bucket for litestream replication.
- A maintainer-controlled hot wallet for each of `HUB_PRIVATE_KEY` and
  `WATCHTOWER_PRIVATE_KEY`. Do **not** reuse keys across environments.

## First-time deploy

Run all commands from the repo root.

### Hub

```bash
# 1. Create the app + persistent volume.
flyctl apps create pico-hub-prod --org <your-org>
flyctl volumes create hub_data --region iad --size 10 --app pico-hub-prod

# 2. Stage and deploy secrets from a local .env file. The script refuses
#    known dev keys and placeholders.
infra/fly/secrets-bootstrap.sh --service hub --env-file ./.secrets/hub-prod.env

# 3. First deploy.
flyctl deploy --remote-only --config infra/fly/hub/fly.toml

# 4. Verify.
flyctl status --app pico-hub-prod
flyctl ssh console --app pico-hub-prod -C 'wget -qO- http://localhost:3030/v1/health'
flyctl ssh console --app pico-hub-prod -C 'wget -qO- http://localhost:9090/metrics | head'
```

The required hub secrets (per `apps/hub/src/config-validate.ts` +
`infra/fly/hub/litestream.yml`): `HUB_PRIVATE_KEY`, `RPC_URL`,
`HUB_OPERATOR_TOKEN`, `LITESTREAM_ACCESS_KEY_ID`, `LITESTREAM_SECRET_ACCESS_KEY`,
`LITESTREAM_R2_BUCKET`, `LITESTREAM_R2_ENDPOINT`.

### Watchtower

```bash
flyctl apps create pico-watchtower-prod --org <your-org>
flyctl volumes create watchtower_data --region lhr --size 5 --app pico-watchtower-prod

infra/fly/secrets-bootstrap.sh --service watchtower --env-file ./.secrets/watchtower-prod.env

flyctl deploy --remote-only --config infra/fly/watchtower/fly.toml

flyctl status --app pico-watchtower-prod
flyctl ssh console --app pico-watchtower-prod -C 'wget -qO- http://localhost:3031/health'
flyctl ssh console --app pico-watchtower-prod -C 'wget -qO- http://localhost:3031/metrics | head'
flyctl logs --app pico-watchtower-prod --process litestream
```

Required secrets: `WATCHTOWER_PRIVATE_KEY`, `RPC_URL`,
`LITESTREAM_ACCESS_KEY_ID`, `LITESTREAM_SECRET_ACCESS_KEY`,
`LITESTREAM_R2_BUCKET`, `LITESTREAM_R2_ENDPOINT`.

The watchtower has **no public Fly service** — its HTTP server (port 3031)
binds to `127.0.0.1` inside the machine. Operators access health/metrics via
`flyctl ssh console` only.

## Normal deploys (after first)

Use the GitHub Action: `.github/workflows/fly-deploy.yml`. Manual trigger,
service + commit SHA inputs. The action verifies the SHA is on a `v*` tag
before invoking flyctl. Mainnet deploys must come from a tagged release.

To deploy locally for emergencies (cleared with the team first):

```bash
flyctl deploy --remote-only --config infra/fly/hub/fly.toml
```

## Secret rotation

Edit your `.env` file with the new value and re-run `secrets-bootstrap.sh`
against the prod app. Fly diffs the secrets and restarts the machine with
the new values. No image rebuild needed.

```bash
infra/fly/secrets-bootstrap.sh --service hub --env-file ./.secrets/hub-prod.env
```

## Rollback

```bash
flyctl releases --app pico-hub-prod
# Pick the previous good image label, e.g. v0.3.1-7706169abcde
flyctl deploy --remote-only \
  --config infra/fly/hub/fly.toml \
  --image registry.fly.io/pico-hub-prod:v0.3.1-7706169abcde
```

## Follow-ups

### Private Fly metrics scraping

Both services support `METRICS_BIND_ADDR`. Fly keeps the default
`127.0.0.1`, and the manifests deliberately omit public services for metrics.
If a sibling Fly Prometheus app needs to scrape over 6PN, set
`METRICS_BIND_ADDR=::` and add private-only Fly services for hub `9090` and
watchtower `3031`.

### `[[files]]` flyctl version

`hub/fly.toml` and `watchtower/fly.toml` use `[[files]]` with `local_path` to
inject the litestream config. If the operator's `flyctl` is too old to parse it,
fall back to
baking the file into a thin wrapper Dockerfile and rebuilding the image.

### Default values via code

`HUB_FEE_BPS`, `HUB_FEE_FLAT`, `CHAIN_POLLING_INTERVAL_MS`,
`CHAIN_CONFIRMATIONS`, `PAYMENT_CHANNEL_ADDRESS`, `ADJUDICATOR_ADDRESS`, etc.
are intentionally NOT set in `[env]`. The code derives defaults from
`@inferenceroom/pico-protocol`'s `CONTRACT_ADDRESSES` for `CHAIN_ID=167000`. Override
via `flyctl secrets set` only when there is a specific operational reason.
