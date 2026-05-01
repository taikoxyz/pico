# Tainnel monitoring stack

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

The two dashboards `Tainnel — Hub Overview` and `Tainnel — Watchtower
Overview` are auto-provisioned. The Prometheus datasource is wired in
automatically; alert rules live in `alerts.yml` and route through
`alertmanager.yml`.

## Pointing at real Fly apps

Edit `prometheus.yml`'s `scrape_configs` and replace
`tainnel-hub-prod.internal:9090` and `tainnel-watchtower-prod.internal:9090`
with your real targets. Reload Prometheus with `curl -X POST
http://prometheus:9090/-/reload` (the compose passes `--web.enable-lifecycle`).

## 🛑 Deployment prerequisite — metrics binding

Both services currently bind their `/metrics` endpoints to `127.0.0.1`:

- Hub: `apps/hub/src/server.ts:116` — `metricsApp.listen({ port:
  config.prometheusPort, host: '127.0.0.1' })`.
- Watchtower: `apps/watchtower/src/index.ts:239` — `http.listen({ port:
  opts.httpPort ?? 0, host: '127.0.0.1' })`.

A Prometheus scraper running in a sibling Fly app **cannot** scrape these —
the listener is not reachable over Fly's 6PN private network. Pick one of
these before flipping mainnet alerts on:

1. Patch hub + watchtower to bind `/metrics` on `::` / `fly-local-6pn` when
   `FLY_APP_NAME` is set, then expose 9090 / 3031 as a private 6PN-only Fly
   service. Cleanest, but needs a code change in both apps.
2. Run Prometheus + Grafana Agent as an additional `[processes]` entry
   inside each app machine and `remote_write` to Grafana Cloud. No bind
   change, but couples scraper lifecycle to app lifecycle.
3. Run a small socat-style relay process that forwards `127.0.0.1:9090` to
   `[fly-local-6pn]:9090`. Hacky.

Until one of these is in place, the scrape config above will report `up == 0`
and `HubDown` / `WatchtowerDown` will fire.

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
`tainnel_watchtower_evaluations_total{result="fraud"}`. The watchtower code
only emits `result="noop"` and `result="penalize"` (see
`apps/watchtower/src/detector.ts:20-86` and
`apps/watchtower/src/scheduler.ts:130`); `result="fraud"` would never fire.
The alert is implemented with `result="penalize"` instead, which is the
faithful equivalent of "the watchtower decided to penalize but no penalty
transaction landed."

## Alert summary

| Alert | Severity | Triggers when |
|---|---|---|
| `HubDown` | critical | `up{job="tainnel-hub"} == 0` for 2m |
| `WatchtowerDown` | critical | `up{job="tainnel-watchtower"} == 0` for 2m |
| `WatchtowerRpcDown` | critical | `tainnel_watchtower_rpc_up == 0` for 5m |
| `DisputeOpened` | critical | any new dispute observed by the hub in 5m |
| `PenaltySubmissionStalled` | critical | penalize-decisions > 0 yet penalty submission rate == 0 for 10m |
| `PaymentFailureRateHigh` | warning | hub payment failure share > 10% for 15m |
| `HubLiquidityLow` | warning | outbound liquidity < 10 USDC for 10m |
| `HubMemoryHigh` | warning | hub RSS > 500 MB for 10m |
| `WatchtowerEvaluationStalled` | warning | watching channels but evaluations rate == 0 for 15m |

Severity routing in `alertmanager.yml`: `critical` → pager, `warning` →
email, anything else → default. All three receivers point at placeholder
webhook URLs; substitute real ones before going live.
