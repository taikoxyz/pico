# Watchtower down

> Replace `<paging-contact>` with your PagerDuty/Opsgenie escalation policy
> before mainnet operations.

## When this fires

- `/health` returns 503 or no response.
- `pico_watchtower_oldest_pending_tx_age_ms` > `INCLUSION_TIMEOUT_MS / 2`.
- `pico_watchtower_oldest_closing_deadline_remaining_ms` < dispute window / 3.
- `pico_watchtower_pending_tx_count` growing unbounded.
- `pico_watchtower_submission_failed_total` rate increasing.
- `pico_watchtower_hot_wallet_eth_balance_wei` below the gas-budget floor.
- Pager: `<paging-contact>`.

## Why it matters

If the watchtower stops responding, a stale unilateral close that lands during the
outage may not be penalized in time. Treat as fund-safety critical.

## Triage

1. GKE health: `kubectl exec -n pico statefulset/pico-watchtower -c watchtower -- wget -qO- http://127.0.0.1:3031/health`.
2. Public/local health, if exposed: `curl -fsS https://watchtower.example/health`.
3. Logs: `kubectl logs -n pico statefulset/pico-watchtower -c watchtower --tail=200`.
4. Check RPC up: `cast block-number --rpc-url $WATCHTOWER_RPC_URL`.
5. Scrape `/metrics` for:
   - `pico_watchtower_pending_tx_count`
   - `pico_watchtower_submission_failed_total`
   - `pico_watchtower_oldest_pending_tx_age_ms`
   - `pico_watchtower_oldest_closing_deadline_remaining_ms`
   - `pico_watchtower_hot_wallet_eth_balance_wei`
6. Check oldest closing deadline; if < 30 min, escalate to the secondary
   watchtower (if any) or manually call
   `cast send <PaymentChannel> "dispute(...)" ...` against the freshest signed
   state from the hub DB.

## Containment

- Restart: `kubectl rollout restart statefulset/pico-watchtower -n pico`.
- If the watchtower private key is suspected compromised, follow
  [watchtower-key-compromise.md](./watchtower-key-compromise.md). The
  watchtower key signs penalty transactions; loss-of-key blocks penalties
  but does not move funds.
- If `pico_watchtower_hot_wallet_eth_balance_wei` is low, top up immediately:
  ```bash
  cast send <wt_hot_wallet> --value <amount> --rpc-url $WATCHTOWER_RPC_URL \
    --private-key $TREASURY_KEY
  ```
- If the SQLite store is corrupt, preserve the damaged DB first and restore
  from Litestream into a fresh volume. Do not restart with an empty DB as a
  recovery strategy: `in_flight_txs` contains penalty-submission state that
  cannot be reconstructed from chain logs alone.

## Recovery checks

- `/health` returns 200.
- `pico_watchtower_pending_tx_count` draining toward zero.
- `pico_watchtower_hot_wallet_eth_balance_wei` above floor.
- A canary stale-state test in a side-channel (using a throwaway channel)
  is penalized end-to-end within the threshold window.

## After-action

- Walk through the deferred-penalty queue (`closing_channels` table) to
  confirm nothing was lost during the outage.
