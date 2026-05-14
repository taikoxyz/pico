# Dispute storm

> Replace `<paging-contact>` with your PagerDuty/Opsgenie escalation policy
> before mainnet operations. Page on detection.

## When to use

- N simultaneous unilateral closes observed against pico channels
  (rule of thumb: more than 5 within a single dispute window, or any
  number that exceeds the watchtower's penalty-tx throughput).
- A coordinated griefing campaign or an attacker exploiting a discovered
  fee-bumping or nonce-starvation weakness.

The watchtower is single-threaded for penalty submission. A storm large
enough to exceed its inclusion-window budget puts funds at risk.

## Signals

- `pico_watchtower_pending_tx_count` climbing fast.
- `pico_watchtower_oldest_pending_tx_age_ms` exceeding
  `INCLUSION_TIMEOUT_MS / 2`.
- `pico_watchtower_oldest_closing_deadline_remaining_ms` shrinking
  faster than we can submit.
- `pico_watchtower_hot_wallet_eth_balance_wei` dropping rapidly.

## Triage

1. Confirm storm scale:
   ```bash
   kubectl exec -n pico statefulset/pico-watchtower -c watchtower -- \
     sqlite3 /data/watchtower.sqlite \
     "SELECT count(*) FROM closing_channels WHERE status = 'closing';"
   ```
2. Capture the list of affected channels sorted by value at risk:
   ```sql
   SELECT channel_id, value_at_risk, deadline_at
     FROM closing_channels
     WHERE status = 'closing'
     ORDER BY value_at_risk DESC, deadline_at ASC;
   ```
3. Page `<paging-contact>`.

## Containment

1. **Prioritise by value at risk × deadline proximity.** The watchtower
   already submits in FIFO order; if value-weighted priority is needed,
   manually submit the highest-value penalties first using a side
   signer (NOT the watchtower's key, to avoid nonce conflicts).
2. **Ensure the watchtower has gas headroom.** Top up
   `pico_watchtower_hot_wallet_eth_balance_wei` aggressively from
   treasury:
   ```bash
   cast send <wt_hot_wallet> --value <budget> \
     --rpc-url $WATCHTOWER_RPC_URL --private-key $TREASURY_KEY
   ```
3. **Monitor nonce starvation.** If the watchtower has many in-flight
   txs, fee-bumping can collide with nonces. Watch logs for
   `replacement transaction underpriced` and `nonce too low`:
   ```bash
   kubectl logs -n pico statefulset/pico-watchtower -c watchtower \
     --tail=1000 | grep -E 'underpriced|nonce too low'
   ```
4. **Pause new opens** if the storm appears to be exploiting a discovered
   bug: `setTokenAllowed(token, false)` via the timelock.

## Recovery

1. Submit penalties until `closing_channels` drains. Reconcile
   `dispute_total` counter against the input list.
2. Document any channels that missed the dispute window — these are
   funds-at-risk events requiring user-direct comms and possibly
   treasury-funded refund.
3. Once stable, do **not** delete `closing_channels` entries; they are
   the audit trail for the storm.

## Communications

- Status page: degraded service. Note that closes are processing but
  slowly; user funds in cooperative-close paths are unaffected.
- If any disputes were lost: funds-at-risk template plus direct outreach
  to affected parties.

## Post-mortem

Use the template in `README.md`. Capture:

- Storm size, attacker pattern, and motivation if known.
- Throughput observed vs. budget; identify the bottleneck (RPC,
  signing, nonce mgmt, fee market).
- Action items: parallel submission, multi-watchtower failover,
  rate-limit on unilateral close, contract-level cooldown.
