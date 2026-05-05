# Dispute response (DRAFT — verify before P10)

## When this fires

- Watchtower observes `ChannelClosingUnilateral` for a channel we hold the
  freshest state for.
- Hub `dispute-handler` selects a state that does not match the latest
  off-chain signed state in our DB.
- Pager: `TODO(contact)`.

## Goal

Submit a counter-state (penalty proof) to the deployed PaymentChannel /
Adjudicator before the dispute window closes.

## Triage

1. Identify the channel id from the alert payload or `chain_watcher` logs.
2. Pull our latest dispute-eligible signed state:
   - GKE hub: `kubectl exec -n pico statefulset/pico-hub -c hub -- sqlite3 /data/hub.sqlite "SELECT * FROM signed_states WHERE channel_id='0x...' ORDER BY version DESC LIMIT 5"`.
   - GKE watchtower: `kubectl exec -n pico statefulset/pico-watchtower -c watchtower -- sqlite3 /data/watchtower.sqlite "SELECT * FROM signed_states WHERE channel_id='0x...' ORDER BY version DESC LIMIT 5"`.
   - hub: `sqlite3 data/hub.sqlite "SELECT * FROM signed_states WHERE channel_id='0x...' ORDER BY version DESC LIMIT 5"`.
   - watchtower: `sqlite3 data/watchtower.sqlite "SELECT * FROM signed_states ..."`.
3. Confirm the state has empty `htlcs` and conserved balances; if not, surface
   that we cannot dispute with HTLCs present (this is a known limitation, see
   `docs/audit/H-08`).
4. Check the dispute deadline: `cast call <PaymentChannel> "channels(bytes32)" 0x...`
   and compute `closingAt + disputeWindowMs` from the response.

## Submit penalty manually (if automation failed)

```bash
cast send $PAYMENT_CHANNEL "dispute(bytes32,(...))" \
  0xCHANNEL_ID '<encoded freshest signed state>' \
  --private-key $WATCHTOWER_PRIVATE_KEY \
  --rpc-url $RPC_URL
```

Wait for `receipt.status === "success"` before declaring success.

## Recovery checks

- `cast call <PaymentChannel> "channelStatus(bytes32)" 0x...` returns "Disputed".
- Hub metrics: `pico_hub_dispute_total{outcome="won"}` incremented.

## After-action

- File `docs/incidents/YYYY-MM-DD-dispute-<channelId>.md` with: stale state
  observed (version, balances, signer), our submitted state (version,
  balances), tx hashes, and dispute window timeline.
