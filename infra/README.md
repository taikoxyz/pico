# Tainnel infrastructure

Production deployment manifests and supporting operational scripts. v1 targets:

- **Hosting:** GKE Autopilot primary, Fly.io preserved as a fallback path.
- **Hub:** single instance + litestream sidecar replicating SQLite to
  Cloudflare R2.
- **Watchtower:** single instance + litestream sidecar replicating SQLite to
  Cloudflare R2.
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
├── k8s/                            GKE Autopilot manifests — see k8s/README.md.
├── fly/                            Fly.io production manifests — see fly/README.md.
└── monitoring/                     Prometheus + Grafana + Alertmanager stack.
```

## Status

The primary automated production deploy path is GKE: `gke-images` builds and
pushes versioned Artifact Registry images on `v*` tags, then calls
`.github/workflows/deploy.yml` to apply rendered manifests and verify rollout.
The Fly.io manual deploy workflow remains available at
`.github/workflows/fly-deploy.yml`. Outstanding ops work is tracked under
[issue #21](https://github.com/dantaik/tainnel/issues/21).

## Build flags

`apps/hub/Dockerfile` and `apps/watchtower/Dockerfile` accept a build arg
`INCLUDE_LITESTREAM=1` that installs the litestream binary alongside the app
process. Default off so dev images stay small.
