# False-positive penalty

> Replace `<paging-contact>` with your PagerDuty/Opsgenie escalation policy
> before mainnet operations. Page immediately.

## When to use

- The watchtower submitted a penalty transaction against a state that
  is, on inspection, the legitimate latest state.
- A counterparty disputes a watchtower-initiated penalty and provides
  evidence of a more recent signed state we should have honoured.
- An internal audit of `signed_states` reveals the watchtower acted on
  stale data due to a sync gap, a clock skew, or a bug.

A false-positive penalty is a **funds-loss event for an honest user**.
Treat it with the same urgency as a drained wallet.

## Signals

- Counterparty complaint, signed off-chain message included.
- `pico_hub_dispute_total{outcome="lost"}` increments.
- Diff between hub and watchtower `signed_states` for the same channel
  shows the watchtower used a stale row.

## Triage (first 10 minutes)

1. **Halt the watchtower immediately** to stop further false positives:
   `kubectl scale -n pico statefulset/pico-watchtower --replicas=0`.
2. Page `<paging-contact>`. Open a private incident channel.
3. Capture the disputed tx hash and the counterparty's claimed state.

## Audit signed_states

1. Pull the full state history for the affected channel from BOTH
   databases:
   ```bash
   kubectl exec -n pico statefulset/pico-hub -c hub -- \
     sqlite3 /data/hub.sqlite \
     "SELECT version, balances, htlcs, sig_user, sig_hub, created_at \
      FROM signed_states WHERE channel_id = '<id>' \
      ORDER BY version ASC;"

   # Note: watchtower may need to be temporarily started to read its DB,
   # OR copy the DB out via `kubectl cp` and read it locally.
   ```
2. Identify the state version the watchtower submitted vs. the state
   version the counterparty claims is fresher.
3. Verify counterparty signatures cryptographically (`cast call` the
   adjudicator's verifier, or replay through
   `@inferenceroom/pico-state-machine` locally).
4. Classify the root cause:
   - **Sync gap**: watchtower DB lagged behind hub DB.
   - **Race**: state was being signed while watchtower triggered.
   - **Bug**: watchtower selected wrong row from a correct DB.
   - **Adversarial**: counterparty colluded with hub to backdate (rare;
     requires hub-side compromise).

## Containment

1. Watchtower stays scaled to 0 until root cause is identified.
2. Notify the affected counterparty within 1 hour: acknowledge the
   false positive, commit to a refund, share preliminary timeline.
3. Do **not** roll back the on-chain dispute decision — the contract
   honoured the state we submitted. Recovery happens off-chain via
   refund.

## Recovery

1. **Refund the wronged counterparty from treasury.** Reconstruct what
   their owed amount would have been from the legitimate latest state.
   Transfer via a single on-chain tx with a memo referencing the
   incident ID.
2. Fix the root cause. Do not restart the watchtower until the fix is
   merged and reviewed.
3. After deploy, run a canary penalty on a throwaway channel to confirm
   correctness end-to-end.

## Communications

- Status page: degraded service entry. State that a penalty decision was
  reversed and the affected party has been compensated.
- Direct outreach to the counterparty with the refund details and an
  apology.
- If the bug class affects other channels, broaden the disclosure:
  funds-at-risk template plus a list of channels to audit.

## Post-mortem

Use the template in `README.md`. Capture:

- The diff between submitted and correct state, with both signatures.
- Root cause classification (sync / race / bug / adversarial).
- Refund amount and recipient.
- Action items: stronger consistency checks between hub and watchtower,
  state-version freshness assertions before submission, integration
  tests covering the failure mode.
