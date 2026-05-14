# Hot wallet drained

> Replace `<paging-contact>` with your PagerDuty/Opsgenie escalation policy
> before mainnet operations. This is sev1 — page immediately.

## When to use

- The hub or watchtower hot wallet balance dropped sharply without
  authorised cause.
- A monitoring alert on `pico_hub_hot_wallet_eth_balance_wei` or
  `pico_watchtower_hot_wallet_eth_balance_wei` fired with a delta larger
  than the budgeted per-window spend.
- An external party reports stolen funds tied to one of our addresses.

This runbook is for drains where the attacker has already moved funds.
For "suspected leak but no movement yet," use
[hub-key-compromise.md](./hub-key-compromise.md) /
[watchtower-key-compromise.md](./watchtower-key-compromise.md).

## Signals

- `pico_hub_hot_wallet_eth_balance_wei` or
  `pico_watchtower_hot_wallet_eth_balance_wei` step-function down.
- Taikoscan tx list shows withdrawals to an unfamiliar address.
- User reports of failed settlement immediately after the drop.

## Triage (first 5 minutes)

1. Confirm via Taikoscan; capture the drain tx hashes.
2. Page `<paging-contact>`. Open the incident channel.
3. Assume the signing key is compromised. Do not retry the same key
   under any circumstances.

## Containment

1. **Pause inbound channel opens / top-ups** via the timelock / Safe:
   ```bash
   cast send <PaymentChannel> "setTokenAllowed(address,bool)" $USDC false
   cast send <PaymentChannel> "setTokenAllowed(address,bool)" $WETH false
   ```
2. **Snapshot the database** before any further state changes:
   ```bash
   kubectl exec -n pico statefulset/pico-hub -c hub -- \
     sqlite3 /data/hub.sqlite ".backup /data/hub-incident-$(date +%s).sqlite"
   kubectl cp pico/<pod>:/data/hub-incident-*.sqlite ./forensics/
   ```
   Repeat for the watchtower DB.
3. **Halt the affected service**:
   `kubectl scale -n pico statefulset/<service> --replicas=0`.
4. **Preserve forensic state**: copy logs, secrets-store audit records,
   container images, and the host audit log to a tamper-evident
   bucket. Do not redeploy until forensics has a copy.

## Recovery

1. Follow the relevant key-compromise runbook:
   - [hub-key-compromise.md](./hub-key-compromise.md) for the hub wallet.
   - [watchtower-key-compromise.md](./watchtower-key-compromise.md) for
     the watchtower wallet.
2. **Refund affected users from treasury** if the drain affected user
   funds (off-chain balances not yet settled). Reconcile the SQLite
   snapshot against on-chain `PaymentChannel` state to compute each
   user's owed amount.
3. **Engage counsel and law enforcement** if the drain is criminal —
   Chainalysis Crypto Investigations, local law enforcement, FBI IC3 for
   US-based operators. Time matters; bridges and mixers act within hours.

## Communications

- Status page: funds-at-risk template. Be explicit that funds were lost
  and that the team is investigating.
- Direct outreach to every affected counterparty with the amount lost
  and the refund plan.
- Follow the disclosure flow in
  [security-disclosure.md](./security-disclosure.md) if the root cause
  is a vulnerability in pico itself.

## Post-mortem

Use the template in `README.md`. This is a multi-week post-mortem at
minimum. Capture:

- Attacker's TTPs.
- Total funds lost; refund amount; treasury impact.
- Detection-time gap (how long between drain tx and our alert).
- Code or operational fix that closes the vector permanently.
- Process action items (HSM, KMS, secrets rotation cadence, separation
  of duties, on-call drill quality).
