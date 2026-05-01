# Tainnel infrastructure

Production deployment manifests and supporting operational scripts. v1 targets:

- **Hosting:** Fly.io (per `docs/plans/09-ops.md`).
- **Hub:** single instance + litestream sidecar replicating SQLite to
  Cloudflare R2.
- **Watchtower:** single instance in a different region from the hub.
- **Monitoring:** Prometheus + Grafana + Alertmanager (`infra/monitoring/`).

## Layout

```
infra/
├── README.md                  This file.
├── docker-compose.prod.yml    Reference production compose (hub + litestream).
├── fly/                       Fly.io production manifests — see fly/README.md.
└── monitoring/                Prometheus + Grafana + Alertmanager stack.
```

## Status

Production manifests live in `fly/` and the deploy workflow at
`.github/workflows/deploy.yml`. See `docs/plans/09-ops.md` for the full P9
task list and `docs/launch-checklist.md` for what gates remain before mainnet
GA.

## Build flags

`apps/hub/Dockerfile` accepts a build arg `INCLUDE_LITESTREAM=1` that installs
the litestream binary alongside the hub process. Default off so dev images
stay small.
