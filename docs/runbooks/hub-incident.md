# Hub incident response (DRAFT — verify before P10)

## When this fires

- WS endpoint refuses connections or returns 5xx for > 60s.
- `/v1/health` returns 503.
- Alert on `tainnel_hub_chain_watcher_lag_blocks` exceeding the deadline budget.
- Pager: `TODO(contact)`.

## Triage (first 5 minutes)

1. Capture the incident timestamp and recent commit SHA from the deploy logs.
2. `curl -fsS https://hub.example/v1/health` and record the response.
3. Tail logs: `fly logs -a tainnel-hub` (or your platform equivalent).
4. Check chain liveness: `cast block-number --rpc-url $RPC_URL`.
5. Check open channels and oldest pending HTLC age via `/metrics`.

## Containment

- If the process is unhealthy but the DB is intact, restart: `fly machine restart -a tainnel-hub`.
- If the chain RPC is down, fail over to the secondary RPC (set `RPC_URL` and restart).
- If the hub key is suspected compromised, follow [key-rotation.md](./key-rotation.md)
  immediately.
- If the DB is lost or corrupt, follow [backup-restore.md](./backup-restore.md).

## Recovery checks

- `/v1/health` returns 200.
- `tainnel_hub_chain_watcher_lag_blocks` < 10.
- `tainnel_hub_payments_total` increases on a synthetic test pay.
- No `htlc:expired` log lines in the last 5 minutes.

## After-action

- File an incident write-up in `docs/incidents/YYYY-MM-DD-<slug>.md`.
- Update this runbook with anything that wasn't captured.
- Confirm watchtower also responded (see [watchtower-down.md](./watchtower-down.md)).
