# Pico monitoring stack

Prometheus + Grafana + Alertmanager wired against the existing `prom-client`
metrics in `apps/hub/src/metrics.ts` and `apps/watchtower/src/metrics.ts`.

## Quickstart (local)

```bash
docker compose -f infra/monitoring/docker-compose.monitoring.yml up
```

Then:

- Prometheus: <http://localhost:9090>
- Alertmanager: <http://localhost:9093>
- Grafana: <http://localhost:3000> (default `admin` / `admin`; override via
  `GRAFANA_ADMIN_USER` and `GRAFANA_ADMIN_PASSWORD`)

The two dashboards `Pico — Hub Overview` and `Pico — Watchtower
Overview` are auto-provisioned. The Prometheus datasource is wired in
automatically; alert rules live in `alerts.yml` and route through
`alertmanager.yml`.

## Pointing at real Fly apps

Edit `prometheus.yml`'s `scrape_configs` and replace
`pico-hub-prod.internal:9090` and `pico-watchtower-prod.internal:9090`
with your real targets. Reload Prometheus with `curl -X POST
http://prometheus:9090/-/reload` (the compose passes `--web.enable-lifecycle`).

## Fly private metrics scraping

Both services support `METRICS_BIND_ADDR`. Fly keeps the default
`127.0.0.1`, so a Prometheus scraper running in a sibling Fly app cannot reach
metrics unless the app manifests set `METRICS_BIND_ADDR=::` and expose
private-only 6PN services for hub `9090` and watchtower `3031`.

## Adding a new alert

Edit `alerts.yml`, then either restart Prometheus or hit `curl -X POST
http://prometheus:9090/-/reload`. Validate with:

```bash
docker run --rm -v $(pwd)/infra/monitoring/alerts.yml:/etc/alerts.yml \
  prom/prometheus:v2.54.1 promtool check rules /etc/alerts.yml
```

## Adding a new dashboard

Drop a JSON file in `grafana/dashboards/`. The provisioning provider rescans
every 30s. To export an edited dashboard from the Grafana UI, use **Share →
Export → Save to file** and overwrite the file in this directory.

## Deviations from spec

The `PenaltySubmissionStalled` alert was originally specified with
`pico_watchtower_evaluations_total{result="fraud"}`. The watchtower code
only emits `result="noop"` and `result="penalize"` (see
`apps/watchtower/src/detector.ts:20-86` and
`apps/watchtower/src/scheduler.ts:130`); `result="fraud"` would never fire.
The alert is implemented with `result="penalize"` instead, which is the
faithful equivalent of "the watchtower decided to penalize but no penalty
transaction landed."

## Alert summary

| Alert | Severity | Triggers when |
|---|---|---|
| `HubDown` | critical | `up{job="pico-hub"} == 0` for 2m |
| `WatchtowerDown` | critical | `up{job="pico-watchtower"} == 0` for 2m |
| `WatchtowerRpcDown` | critical | `pico_watchtower_rpc_up == 0` for 5m |
| `DisputeOpened` | critical | any new dispute observed by the hub in 5m |
| `PenaltySubmissionStalled` | critical | penalize-decisions > 0 yet penalty submission rate == 0 for 10m |
| `PaymentFailureRateHigh` | warning | hub payment failure share > 10% for 15m |
| `HubLiquidityLow` | warning | outbound liquidity < 10 USDC for 10m |
| `HubMemoryHigh` | warning | hub RSS > 500 MB for 10m |
| `WatchtowerEvaluationStalled` | warning | watching channels but evaluations rate == 0 for 15m |

Severity routing in `alertmanager.yml`: `critical` → pager, `warning` →
email, anything else → default. All three receivers point at placeholder
webhook URLs; substitute real ones before going live.
