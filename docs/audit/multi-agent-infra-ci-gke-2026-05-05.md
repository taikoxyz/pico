# Multi-agent infra/CI/GKE audit pass

Date: 2026-05-05
Scope: `infra`, `.github/workflows`, GKE manifests, monitoring, and backup
drills.
Status: repo-side fixes implemented; live drills/secrets pending.

## Findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| MAG-INF-001 | High | `e2e-fork` was structurally required but still passed on protected refs when the RPC secret was absent. | Fixed |
| MAG-INF-002 | Medium | Production Litestream restore drill workflow was missing; staging-only drill existed. | Fixed |
| MAG-INF-003 | Medium | GKE deploys used mutable version tags instead of digest references. | Fixed |
| MAG-INF-004 | Medium | Grafana allowed UI updates but stored `/var/lib/grafana` on `emptyDir`. | Fixed |
| MAG-INF-005 | High | Live Alertmanager on v0.27.0 crashed during webhook notification. | Manifest upgraded; live rollout pending |
| MAG-INF-006 | Low | DNS egress NetworkPolicy uses GKE-cluster-specific DNS IPs. | Document/verify per cluster |

## Remaining gates

- Set `TAIKO_MAINNET_RPC_URL` and optional `E2E_USDC_WHALE`.
- Set read-only `PROD_LITESTREAM_*` secrets and run
  `.github/workflows/backup-drill-prod.yml` successfully once.
- Roll out the Alertmanager image update and confirm synthetic alert delivery.
- Confirm Grafana PVC persistence after rollout.

This report is the in-repo multi-agent synthesis. Issue #36's named-model report
acceptance criteria still require separate external model outputs.
