# Watchtower down (DRAFT — verify before P10)

## When this fires

- `/health` returns 503 or no response.
- `pico_watchtower_oldest_pending_tx_age_ms` > `INCLUSION_TIMEOUT_MS / 2`.
- `pico_watchtower_oldest_closing_deadline_remaining_ms` < dispute window / 3.
- Pager: `TODO(contact)`.

## Why it matters

If the watchtower stops responding, a stale unilateral close that lands during the
outage may not be penalized in time. Treat as fund-safety critical.

## Triage

1. GKE health: `kubectl exec -n pico statefulset/pico-watchtower -c watchtower -- wget -qO- http://127.0.0.1:3031/health`.
2. Public/local health, if exposed: `curl -fsS https://watchtower.example/health`.
3. Logs:
   - GKE: `kubectl logs -n pico statefulset/pico-watchtower -c watchtower --tail=200`.
   - Fly: `fly logs -a pico-watchtower`.
4. Check RPC up: `cast block-number --rpc-url $WATCHTOWER_RPC_URL`.
5. Check `pico_watchtower_pending_tx_count` and `..._submission_failed_total`.
6. Check oldest closing deadline; if < 30 min, escalate to the secondary
   watchtower (if any) or manually call
   `cast send <PaymentChannel> "dispute(...)" ...` against the freshest signed
   state from the hub DB.

## Containment

- Restart:
  - GKE: `kubectl rollout restart statefulset/pico-watchtower -n pico`.
  - Fly: `fly machine restart -a pico-watchtower`.
- If the watchtower private key is suspected compromised, follow
  [key-rotation.md](./key-rotation.md). The watchtower key signs penalty
  transactions; loss-of-key blocks penalties but does not move funds.
- If the SQLite store is corrupt, preserve the damaged DB first and restore
  from Litestream into a fresh volume. Do not restart with an empty DB as a
  recovery strategy: `in_flight_txs` contains penalty-submission state that
  cannot be reconstructed from chain logs alone.

## Recovery checks

- `/health` returns 200.
- A canary stale-state test in a side-channel (using a throwaway channel)
  is penalized end-to-end within the threshold window.

## After-action

- Walk through the deferred-penalty queue (`closing_channels` table) to
  confirm nothing was lost during the outage.
