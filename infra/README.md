# Tainnel infrastructure (DRAFT — placeholder for P9)

This directory holds the production deployment manifests and supporting
operational scripts. v1 targets:

- **Hosting:** Fly.io (per `docs/plans/09-ops.md`).
- **Hub:** single instance + litestream sidecar replicating SQLite to
  Cloudflare R2.
- **Watchtower:** single instance in a different region from the hub.
- **Monitoring:** local Prometheus + structured logs (no SaaS observability).

## Layout

```
infra/
├── README.md                  This file.
├── docker-compose.prod.yml    Reference production compose (hub + litestream).
└── fly/                       (TODO P9) fly.toml manifests for hub + watchtower.
```

## Status

Most of P9 is still planning-only. The compose file shows the intended
hub + litestream sidecar layout for review; it is not yet wired into a CI
deploy. See `docs/plans/09-ops.md` for the full P9 task list.

## Build flags

`apps/hub/Dockerfile` accepts a build arg `INCLUDE_LITESTREAM=1` that installs
the litestream binary alongside the hub process. Default off so dev images
stay small.
