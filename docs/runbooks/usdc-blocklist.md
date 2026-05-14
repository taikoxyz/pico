# USDC blocklist event

> Replace `<paging-contact>` with your PagerDuty/Opsgenie escalation policy
> before mainnet operations. This is sev1 if it affects the hub hot wallet.

## When to use

- Circle has blocklisted the hub hot wallet (or any wallet pico settles
  USDC through).
- Circle has globally paused USDC transfers.
- See [`COMPLIANCE.md`](../../COMPLIANCE.md) §1 for background on Circle's
  blocklist and pause capabilities.

## Signals

- `cast send` of USDC from the hub hot wallet reverts with the
  `Blacklisted(address)` error or Circle's pause-state error.
- `pico_watchtower_submission_failed_total` and the hub on-chain settle
  metric both spike with USDC-only errors; ETH paths work normally.
- Public Circle communication or social-media reports referencing the
  hub address.

## Triage

1. Confirm scope:
   - Is just the hub wallet blocked? Compare with a clean wallet (e.g.
     `cast call $USDC "isBlacklisted(address)(bool)" <hub_hot_wallet>`).
   - Is USDC globally paused?
     `cast call $USDC "paused()(bool)"`.
2. Inventory exposure:
   ```bash
   sqlite3 hub.sqlite \
     "SELECT count(*), sum(amount) FROM channels \
      WHERE token = '<usdc_addr>' AND status = 'open';"
   ```
3. Page `<paging-contact>`.

## Containment

1. **Disable USDC channel opens immediately** (via the timelock / Safe):
   ```bash
   cast send <PaymentChannel> "setTokenAllowed(address,bool)" $USDC false
   ```
   This prevents new exposure. Existing USDC channels remain on-chain but
   cannot be settled through the blocked wallet.
2. **Drain unaffected positions**: any ETH channel can continue to
   settle. Encourage ETH-channel users to cooperative-close to lock in
   their position before any escalation.
3. **Do not attempt** to route around the block by using a fresh wallet
   without legal sign-off — that path can compound the regulatory
   problem (see [`COMPLIANCE.md`](../../COMPLIANCE.md) §2-3).

## Recovery (waiting for unblock)

1. Maintain a clear log of every channel affected and its last
   off-chain signed state.
2. Engage counsel to communicate with Circle about the unblock process.
3. If the block is lifted: re-enable `setTokenAllowed(USDC, true)`
   through the timelock and resume settlement.
4. If the block is permanent: accept loss path. The on-chain USDC sits
   in `PaymentChannel`; participants can still attempt unilateral close
   and Circle-side recovery via their counsel.

## Recovery (v2.1 mitigation path)

Pull-pattern channel close (tracked in the v2.1 spec; PR #127 §6.2)
lets each participant pull their own settled USDC directly from
`PaymentChannel`, removing the hub hot wallet as a chokepoint for
blocklist events. After v2.1 ships, this runbook collapses to "disable
new opens; users pull settlements at will."

## Communications

- Status page: funds-at-risk template, plain-language explanation:
  "Circle, the issuer of USDC, has blocklisted a wallet pico uses to
  settle USDC channels. USDC channels cannot settle until this is lifted.
  ETH channels are unaffected. We are coordinating with Circle."
- Direct outreach: notify every USDC channel counterparty with the
  amount affected and the unblock timeline (if known).

## Post-mortem

Use the template in `README.md`. Include:

- Why the wallet was blocklisted (legitimate sanctions match? false
  positive? our screening gap?).
- Funds frozen and duration.
- Action items: screening at admit-gate (see
  [`COMPLIANCE.md`](../../COMPLIANCE.md) §2), v2.1 pull-pattern timeline,
  documentation updates to ToS.
