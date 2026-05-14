# Hub incident response

> Replace `<paging-contact>` with your PagerDuty/Opsgenie escalation policy
> before mainnet operations.

## When this fires

- WS endpoint refuses connections or returns 5xx for > 60s.
- `/v1/health` returns 503.
- Alert on `pico_hub_chain_watcher_lag_blocks` exceeding the deadline budget.
- Alert on `pico_hub_hot_wallet_eth_balance_wei` below the gas-budget floor
  (the hub cannot post on-chain ops without gas).
- Pager: `<paging-contact>`.

## Triage (first 5 minutes)

1. Capture the incident timestamp and recent commit SHA from the deploy logs
   (`kubectl -n pico describe pod <pod>` shows the image SHA).
2. `curl -fsS https://hub.example/v1/health` and record the response.
3. Tail logs: `kubectl logs -n pico statefulset/pico-hub -c hub --tail=200`.
4. Check chain liveness: `cast block-number --rpc-url $RPC_URL`.
5. Check open channels and oldest pending HTLC age via `/metrics`.
6. Scrape `/metrics` for the key gauges:
   - `pico_hub_chain_watcher_lag_blocks` (lag behind chain tip).
   - `pico_hub_hot_wallet_eth_balance_wei` (gas headroom).

## Containment

- If the process is unhealthy but the DB is intact, restart:
  `kubectl rollout restart statefulset/pico-hub -n pico`.
- If the chain RPC is down, fail over to the secondary RPC:
  `kubectl -n pico set env statefulset/pico-hub RPC_URL=<backup>` and then
  `kubectl rollout restart statefulset/pico-hub -n pico`.
- If the hub key is suspected compromised, follow
  [hub-key-compromise.md](./hub-key-compromise.md) immediately.
- If the DB is lost or corrupt, follow [backup-restore.md](./backup-restore.md).
- If the hot wallet ETH balance is critically low, top up before further ops:
  ```bash
  cast send <hub_hot_wallet> --value <amount> --rpc-url $RPC_URL \
    --private-key $TREASURY_KEY
  ```
- For a cluster-level event (node drain), inspect the underlying nodes:
  `gcloud container clusters describe <cluster> --region <region>` and
  `kubectl get nodes -o wide`.

## Recovery checks

- `/v1/health` returns 200.
- `pico_hub_chain_watcher_lag_blocks` < 10.
- `pico_hub_hot_wallet_eth_balance_wei` above the alert floor.
- `pico_hub_payments_total` increases on a synthetic test pay.
- No `htlc:expired` log lines in the last 5 minutes.

## After-action

- File an incident write-up in `docs/incidents/YYYY-MM-DD-<slug>.md`.
- Update this runbook with anything that wasn't captured.
- Confirm watchtower also responded (see [watchtower-down.md](./watchtower-down.md)).
