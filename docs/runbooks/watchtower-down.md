# Watchtower down (DRAFT — verify before P10)

## When this fires

- `/health` returns 503 or no response.
- `tainnel_watchtower_oldest_pending_tx_age_ms` > `INCLUSION_TIMEOUT_MS / 2`.
- `tainnel_watchtower_oldest_closing_deadline_remaining_ms` < dispute window / 3.
- Pager: `TODO(contact)`.

## Why it matters

If the watchtower stops responding, a stale unilateral close that lands during the
outage may not be penalized in time. Treat as fund-safety critical.

## Triage

1. `curl -fsS https://watchtower.example/health`.
2. Logs: `fly logs -a tainnel-watchtower`.
3. Check RPC up: `cast block-number --rpc-url $WATCHTOWER_RPC_URL`.
4. Check `tainnel_watchtower_pending_tx_count` and `..._submission_failed_total`.
5. Check oldest closing deadline; if < 30 min, escalate to the secondary
   watchtower (if any) or manually call
   `cast send <PaymentChannel> "dispute(...)" ...` against the freshest signed
   state from the hub DB.

## Containment

- Restart: `fly machine restart -a tainnel-watchtower`.
- If the watchtower private key is suspected compromised, follow
  [key-rotation.md](./key-rotation.md). The watchtower key signs penalty
  transactions; loss-of-key blocks penalties but does not move funds.
- If the SQLite store is corrupt, copy `data/watchtower.sqlite` to
  `data/watchtower.sqlite.broken-<ts>` and restart with a fresh DB; the
  detector will recover the in-flight set from chain logs on next catch-up.

## Recovery checks

- `/health` returns 200.
- A canary stale-state test in a side-channel (using a throwaway channel)
  is penalized end-to-end within the threshold window.

## After-action

- Walk through the deferred-penalty queue (`closing_channels` table) to
  confirm nothing was lost during the outage.
