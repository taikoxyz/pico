# Watchtower signing key compromise

> Replace `<paging-contact>` with your PagerDuty/Opsgenie escalation policy
> before mainnet operations. Page immediately on confirmed compromise.

## When to use

- `WATCHTOWER_PRIVATE_KEY` is suspected leaked: host breach, leaked
  `.env`, exposed backup, credentials in a public dump.
- Outbound transactions from the watchtower hot wallet that the operator
  did not authorise.
- Insider departure with prior access to the secret store.

## Why it's lower-radius than the hub key

The watchtower key signs penalty (dispute) transactions only. It cannot
move user funds out of `PaymentChannel`. Compromise consequences:

- An attacker with the key can grief by submitting valid penalty txs
  early or spending all hot-wallet gas. Funds in open channels remain
  safe via the protocol's cooperative-close path.
- Loss of the key (without compromise) means we cannot slash stale closes
  until the new key is deployed — this IS a funds-at-risk window.

## Signals

- `pico_watchtower_hot_wallet_eth_balance_wei` dropping without ops cause.
- Unexpected entries in `in_flight_txs` (see
  `apps/watchtower/src/storage.ts:131-166`).
- `pico_watchtower_submission_failed_total` rate spike with
  unrecognised error patterns.
- Reporter contact via `security@taiko.xyz`.

## Triage (first 10 minutes)

1. Confirm the indicator: `cast balance <wt_hot_wallet>`, recent tx
   history, and `kubectl -n pico logs statefulset/pico-watchtower
   --tail=500`.
2. Page `<paging-contact>`. Open a private incident channel.
3. Decide containment: if user funds are not under direct threat, prefer
   "stop the watchtower, rotate, restart" over "drain wallet" — the
   watchtower needs a funded hot wallet to do its job.

## Containment

1. **Stop the watchtower**:
   `kubectl scale -n pico statefulset/pico-watchtower --replicas=0`.
2. **Drain the watchtower hot wallet** to treasury using the (now
   suspect) key, in case the attacker tries to spend it:
   ```bash
   cast send <treasury> --value <balance - gas> \
     --private-key $WATCHTOWER_PRIVATE_KEY --rpc-url $WATCHTOWER_RPC_URL
   ```
3. **Stand up an emergency operator** to manually dispute any stale
   closes during the rotation window. Use the dispute-response
   procedure in [dispute-response.md](./dispute-response.md) and sign
   penalty txs with a fresh, isolated key (NOT the compromised one).

## Recovery

1. Generate a new key in an isolated host. Fund it from treasury.
2. Update the secret:
   `infra/k8s/secrets-bootstrap.sh --service watchtower --env-file <new-env>`.
3. Bring the watchtower back:
   `kubectl scale -n pico statefulset/pico-watchtower --replicas=1`.
4. Verify:
   - `/health` returns 200.
   - `pico_watchtower_hot_wallet_eth_balance_wei` above floor.
   - `pico_watchtower_pending_tx_count` resumes normal flow.
5. Audit `in_flight_txs` for any unauthorised submissions from the
   compromise window.

## Communications

- Internal only unless there was a funds-loss event. The watchtower key
  scope does not require a user-facing disclosure absent confirmed
  griefing or actual loss.
- If there is loss, follow the disclosure flow in
  [security-disclosure.md](./security-disclosure.md).

## Post-mortem

Use the template in `README.md`. Capture:

- Root cause of the leak.
- Whether any stale closes landed during the rotation window without
  being penalised (review `closing_channels` table).
- Hardening action items.
