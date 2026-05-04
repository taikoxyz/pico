# Key rotation (DRAFT — verify before P10)

## When to rotate

- Scheduled rotation (recommended at least quarterly while in real-money mode).
- Suspected key compromise (host breach, leaked .env, leaked backup,
  third-party access incident).
- Operator handoff between maintainers.

## Keys in scope

| Key | Purpose | Where stored | Blast radius |
|---|---|---|---|
| `HUB_PRIVATE_KEY` | hub co-signs channel states; cannot move funds without channel-party sigs | env var on hub host | hub forced offline, channels recover via cooperative close once new key takes over |
| `WATCHTOWER_PRIVATE_KEY` | pays for penalty txs | env var on watchtower host | inability to slash; funds at risk if a stale close lands during rotation |
| `HUB_OPERATOR_TOKEN` | bearer for `/v1/channels/open` and `/v1/channels` | env var on hub host | enables operator REST endpoints; rotate immediately on suspected leak |

## Procedure (clean rotation)

1. Generate the new key in an isolated host (offline preferred):
   `cast wallet new` or your KMS export.
2. Funded amounts: send minimum gas budget to the new address.
3. Deploy the new env to the host: `fly secrets set HUB_PRIVATE_KEY=0x...`.
4. Restart the service: `fly machine restart -a pico-hub`.
5. Verify `/v1/health` returns 200.
6. Once confirmed, sweep gas from the old key back to a treasury address.
7. Document the rotation in `docs/incidents/YYYY-MM-DD-rotation.md`.

## Procedure (compromise suspected)

1. Immediately rotate as above.
2. Open `dispute-response.md` and watch for stale-close attempts using the
   compromised key.
3. Audit recent signed states for any not authorized by the operator; if any
   are present, contact the affected channel parties.

## Verification

- `pico_hub_chain_watcher_lag_blocks` returns to baseline.
- WS subscribers can reconnect and exchange a `ping` round-trip.
- Operator REST `GET /v1/channels` works only with the new bearer token.
