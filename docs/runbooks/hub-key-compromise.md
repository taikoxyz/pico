# Hub signing key compromise

> Replace `<paging-contact>` with your PagerDuty/Opsgenie escalation policy
> before mainnet operations. This is a sev1 — page immediately.

## When to use

- `HUB_PRIVATE_KEY` is suspected leaked: host breach, leaked `.env`,
  exposed backup, credentials in a public dump, or unexplained signed
  states observed on-chain.
- Outbound transactions originating from the hub hot wallet that the
  operator did not authorise.
- Insider departure with prior access to the secret store.

## Signals

- `pico_hub_hot_wallet_eth_balance_wei` dropping without scheduled use.
- Unrecognised `setTokenAllowed` or operator-REST audit-log entries.
- Public-source signal: leaked credentials appearing in a paste site or
  alerted by a secrets-scanner (e.g. GitHub Secret Scanning, gitleaks).
- Reporter contact via `security@taiko.xyz`.

## Triage (first 10 minutes)

1. Confirm the indicator is real: `cast balance <hub_hot_wallet>`, recent
   tx history on Taikoscan, and `kubectl -n pico logs ...` audit lines.
2. Treat as confirmed until proven otherwise. **Do not** wait for full
   forensic confirmation before containment.
3. Open a private incident channel; page `<paging-contact>`.

## Containment

1. **Halt new channel opens and top-ups** at the contract layer. Pausable
   support is tracked under the v2 roadmap; until then, the equivalent is:
   ```bash
   # Via the timelock / Safe, schedule + execute:
   cast send <PaymentChannel> "setTokenAllowed(address,bool)" $USDC false
   cast send <PaymentChannel> "setTokenAllowed(address,bool)" $WETH false
   ```
   This blocks new opens / topUps. Existing channels can still close.
2. **Drain the hub hot wallet** to a fresh treasury address signed by a
   key that is NOT in scope of the compromise:
   ```bash
   cast send <treasury> --value <balance - gas> \
     --private-key $HUB_PRIVATE_KEY --rpc-url $RPC_URL
   ```
   Yes — you use the compromised key once more to drain it. Race the
   attacker; if they have it, they're already trying.
3. **Stop the hub** to prevent further use of the compromised key:
   `kubectl scale -n pico statefulset/pico-hub --replicas=0`.

## Recovery

1. Generate a new key in an isolated host (offline preferred):
   `cast wallet new` or via your KMS. Fund the new address from treasury
   with the minimum gas budget.
2. Update the secret:
   `infra/k8s/secrets-bootstrap.sh --service hub --env-file <new-env>`.
3. Bring the hub back: `kubectl scale -n pico statefulset/pico-hub --replicas=1`.
4. Re-enable allowlisted tokens through the timelock once you have
   verified the new deployment is signing correctly.
5. Audit every signed state in `signed_states` from the suspected
   compromise window for unauthorised signatures.

## Communications

- Status page: use the "funds-at-risk" template
  (see `README.md` → Communication templates).
- Direct outreach: notify all WS subscribers and operator-REST API
  consumers via their on-file contact channel. Provide:
  - The new hub hot wallet address.
  - The window during which signatures from the old key should be treated
    as suspect.
  - The action subscribers should take (e.g. cooperative-close existing
    channels and reopen).

## Post-mortem

Use the post-mortem template in `README.md`. Include:

- Root cause of the leak (forensic timeline).
- Every signed state from the compromise window, classified as
  legitimate / suspect / malicious.
- Action items to prevent recurrence (HSM, KMS, key-rotation cadence,
  secret-scanning).
