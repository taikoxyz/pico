# Tainnel infrastructure

Production deployment manifests and supporting operational scripts. v1 targets:

- **Hosting:** Fly.io.
- **Hub:** single instance + litestream sidecar replicating SQLite to
  Cloudflare R2.
- **Watchtower:** single instance in a different region from the hub.
- **Monitoring:** Prometheus + Grafana + Alertmanager (`infra/monitoring/`).

## Layout

```
infra/
├── README.md                       This file.
├── docker-compose.prod.yml         Hub-host compose (hub + litestream sidecar).
├── docker-compose.watchtower.yml   Watchtower-host compose (watchtower + litestream).
├── litestream/
│   ├── hub.yml                     Litestream config for the hub DB.
│   └── watchtower.yml              Litestream config for the watchtower DB.
├── scripts/
│   └── restore-drill.sh            Restore-from-backup drill (used by CI).
├── fly/                            Fly.io production manifests — see fly/README.md.
└── monitoring/                     Prometheus + Grafana + Alertmanager stack.
```

## Status

Production manifests live in `fly/` and the deploy workflow at
`.github/workflows/deploy.yml`. Outstanding ops work is tracked under
[issue #21](https://github.com/dantaik/tainnel/issues/21).

## Build flags

`apps/hub/Dockerfile` accepts a build arg `INCLUDE_LITESTREAM=1` that installs
the litestream binary alongside the hub process. Default off so dev images
stay small.
