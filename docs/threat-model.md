# Threat model (v1)

> Status: **frozen** as of P1 (2026-04). Each section identifies an adversary or
> failure class, the capabilities granted to it, the attack vectors against specific
> protocol fields, and the mitigations the protocol relies on. References to spec
> sections use `protocol-spec.md § X.Y`.

## Malicious user

**Capabilities**: a signing party (userA or userB) with full off-chain authority
over their key, willing to submit on-chain transactions and withhold cooperation.

**Attack vectors**:

- *Stale-state submission*: user submits an old `ChannelState` (low `version`) on-chain
  via `closeUnilateral` to claim a more favorable balance distribution that has since
  been superseded. Targets `protocol-spec.md § 2` invariants (monotonic version).
- *State-skip*: user signs and submits a state without a corresponding `Update`
  wrapper, attempting to bypass the prev→next intent check. Targets the `Update`
  typed-data (§ 6.2).
- *HTLC double-spend*: user adds an HTLC, settles it, then submits the pre-settle
  state on dispute to "rewind" the settlement. Targets `htlcsRoot` and HTLC reveal
  flow (§ 3, § 5.4). In v2 this is defeated by: (a) on-chain Merkle proof
  verification of the HTLC in `claimHtlc`, (b) the dual-signature requirement
  on any disputed state, and (c) the conservation invariant
  `balanceA + balanceB + htlcsTotalLocked == amountA + amountB` baked into
  `ChannelState`. The attacker would need the counterparty's signature on the
  pre-settle state, which the protocol never produces post-settle.
- *Grief via dust*: user opens many small channels with the hub to inflate hub
  collateral pressure. Targets the per-token `minChannelAmount` floor on
  `PaymentChannel`.

**Mitigations**:

- The 24-hour dispute window (§ 5.1) gives the counterparty (or watchtower) time to
  challenge with a newer dual-signed state. Stale submissions are reverted.
- A successful `dispute` (newer dual-signed state) automatically slashes the closer
  for 100% of the pot at finalize, identical to `submitPenaltyProof`. The closer
  cannot escape the slash by self-calling `dispute` (or hiring any third party): any
  successful dispute is by definition proof that a strictly-newer dual-signed state
  existed at close time, which is the on-chain definition of stale-state cheating.
- All transitions require both signatures over the resulting `ChannelState`; the
  state-machine in `@inferenceroom/pico-state-machine` enforces strict version monotonicity
  (`replay.ts:ensureMonotonicVersion`).
- v2 implements on-chain HTLC settlement. The contracts accept non-empty
  `htlcsRoot` at unilateral close/dispute and enter `Status.ResolvingHtlcs`
  after the dispute window; `claimHtlc` (preimage + Merkle proof) and
  `refundHtlc` (proof, post-expiry) settle each HTLC permissionlessly. The
  cooperative close artifact still carries no HTLC root and is therefore
  client/hub-gated to channels with no in-flight HTLCs, but force-close no
  longer strands in-flight value. Watchtowers must persist the full HTLC set
  per signed state (not just the root) so they can build proofs at
  resolution time. Preimage emission on `HtlcClaimed` is intentional —
  payment-hash reuse across channels is forbidden by the protocol, so the
  event leaks no cross-channel information.
- The owner-managed `minChannelAmount[token]` floor (v1 default: 10 USDC for
  USDC, 0.01 ETH for ETH when enabled) raises the per-channel cost above
  expected gas, deterring dust grief. Tokens without a configured floor accept
  any non-zero amount, so the owner SHOULD seed a sensible per-token minimum at
  the same time as `setTokenAllowed`.
- ETH channel disbursement uses `call{value:}` and reverts the whole tx on a
  failing leg. A contract participant whose `receive()` reverts (or consumes
  more gas than the EVM's 63/64 forwarding allows) can lock channel funds at
  `closeCooperative` / `finalize`. v1 mitigation is operator-side: ETH channel
  counterparties SHOULD be EOAs or contracts with a trivial
  `receive() external payable {}`. A future revision may move to a pull-pattern
  (per-address `pendingWithdrawals` + `withdraw()`) so one failing leg cannot
  block the other party's funds.

## Malicious hub

**Capabilities**: routing operator that signs channel updates with all clients,
controls the WebSocket relay, and orders payment-forwarding decisions.

**Attack vectors**:

- *Steal in-flight*: hub takes the sender's HTLC amount but never forwards to the
  receiver. Targets atomic settlement (§ 4.1).
- *Selective censorship*: hub refuses to sign updates for a specific user, freezing
  their funds in the channel. Targets liveness, not safety.
- *Fee inflation*: hub charges more than the advertised `FlatPlusBpsFeePolicy`. Targets
  the fee invariant (§ 4.2).
- *Stall*: hub holds an HTLC open until just before expiry, hoping the sender's
  watchtower is offline at that moment.

**Mitigations**:

- Atomic settlement via shared preimage (§ 4.1): the hub cannot claim from the
  sender's HTLC without first paying the receiver. Theft is economically impossible,
  not just discouraged.
- Liveness griefing is fundamental to channel networks; the user's recourse is
  unilateral close after the dispute window. Funds are always recoverable on-chain.
- Fee discrepancy is caught client-side: the SDK refuses to sign an HTLC whose
  amount exceeds `amount + fee(amount)` per the published policy.
- Hop expiry margin (`T_outer - T_inner ≥ safety_margin`, § 4.1) plus watchtower
  coverage (see § Watchtower offline) bound stall risk.

## Malicious DVM

**Capabilities**: a Data Vending Machine that publishes `PaymentQuote` /
`PaymentInvoice` events and is supposed to deliver work in exchange for payment.

**Attack vectors**:

- *Bait quote*: DVM advertises a low price, then refuses to deliver after the HTLC
  is added.
- *Mis-priced invoice*: invoice references a different `paymentHash` than the quote.
- *Claim-without-deliver*: DVM publishes `PaymentReceipt` (§ 6.3) without actually
  performing the work.

**Mitigations**:

- HTLCs only settle when the DVM reveals the preimage; the DVM-controlled preimage
  reveal is what authorizes payment, so a DVM that doesn't deliver also doesn't get
  paid (the HTLC expires and refunds the sender).
- The client SDK pins the `paymentHash` from the original quote into the HTLC,
  preventing post-hoc swap.
- `PaymentReceipt` is purely informational; settlement is purely on-chain HTLC
  revelation. Receipts are not load-bearing for payment finality.
- Delivery dispute is out of scope at the channel layer; it lives in the DVM
  application semantics.

## Network partition

**Capabilities**: an attacker who can selectively delay or drop traffic between any
two parties (user, hub, watchtower, RPC), but cannot forge signatures.

**Attack vectors**:

- *Eclipse the user during dispute*: prevent the user (and their watchtower) from
  observing a stale-state submission until after the 24-hour window expires.
- *Stall HTLC reveal*: drop preimage messages so an HTLC expires even though the
  receiver intended to settle.
- *Block off-chain updates*: prevent both parties from agreeing on new states,
  freezing the channel.

**Mitigations**:

- Watchtowers are designed for this exact case (§ 5.6): a single reachable RPC
  endpoint is sufficient to post a challenge during the 24h window.
- Receivers SHOULD reveal preimage with sufficient buffer before expiry (recommended:
  reveal at least `T_inner / 2` before expiry).
- Multiple Nostr relays (`protocol-spec.md § 6.3`) reduce the partition surface for
  off-chain transport; a partitioned client falls back to direct hub WebSocket.

## Chain reorg

**Capabilities**: a reorg of depth `d` blocks on Taiko L2.

**Attack vectors**:

- *Reorg an `open`*: an attacker reorgs the chain after a channel-open event was
  observed off-chain, leaving the depositor without on-chain backing while their
  counterparty believed the channel was funded.
- *Reorg a `finalize`*: undo a finalized close, allowing a stale-state replay.
- *Reorg HTLC settlement*: undo on-chain HTLC reveal, reverting funds.

**Mitigations**:

- All state-machine `applyUpdate` consumers wait for `≥ 12 block confirmations`
  before treating any on-chain transition as final, well beyond Taiko's expected
  reorg depth.
- The `chainId` in the EIP-712 domain (§ 6.1) prevents cross-chain replay should a
  reorg span a hard fork.
- Deposits MAY be considered final earlier (≥ 6 blocks) since the depositor is the
  victim of a reorg-front-run, and they control whether to consider the channel
  active. Withdrawals strictly require the full window.

## Watchtower offline

**Capabilities**: the user's watchtower service is unavailable during all or part of
a 24-hour dispute window.

**Attack vectors**:

- *Stale-state steal*: the counterparty submits an outdated `ChannelState` while the
  user is offline AND their watchtower cannot post a challenge before the window
  expires. Funds settle to the stale state.
- *HTLC unrevealed*: the user has a pending in-bound HTLC; their watchtower was
  responsible for posting the preimage on-chain in dispute. Without the watchtower,
  the HTLC expires and refunds to the sender.

**Mitigations**:

- The 24-hour window (§ 5.1) is sized for redundant watchtower posting: at least
  one of N watchtowers needs liveness for a single submission within the window.
- Users SHOULD configure watchtowers across independent operators / hosting providers
  (recommended: 2-of-3 redundancy).
- The detector subsystem (`packages/watchtower/src/detector`) monitors the
  `Adjudicator` contract for `closeUnilateral` events and triggers challenge posting
  when a newer state is held.
- Residual risk: a user with no functioning watchtower for a full 24 hours is
  exposed. This is a documented operator responsibility, not a protocol guarantee.

## Privacy (non-goal in v1, scaffolded for v1.x)

**Topology limit**: pico is 1-hop. The hub sees every payment's sender,
recipient, amount, paymentHash, and timing by construction. No protocol
trick removes this while topology is 1-hop. This is a deliberate v1
trade-off in exchange for routing simplicity and bounded latency
(see `ARCHITECTURE.md § Why 1-hop`).

**Other observers** (chain analysts, Nostr relays, watchtowers, third
parties who see only dispute postings) are addressed incrementally:

- **Stealth `userA` per channel** breaks chain-graph clustering of one
  user's channels.
- **Recipient `userB` rotation** breaks on-chain clustering of payments
  to the same DVM/end-user.
- **Ephemeral Nostr pubkeys per payment session** prevent relays from
  linking PaymentQuote / PaymentInvoice / PaymentReceipt to one DVM.
- **Fee bucketing** in `FlatPlusBpsFeePolicy` collapses adjacent
  payments into the same outer-HTLC value.
- **PTLCs** (v2.x protocol bump) make the two legs of a routed payment
  carry different on-chain commitments, neutralizing the v2 HTLC
  settlement path as a correlation oracle (a force-close that resolves
  HTLCs on chain currently emits the matching `paymentHash` on both
  legs via `HtlcClaimed`).

SDK / state-machine / hub helpers for these landed in PR #90. End-to-end
integration into `ChannelClient`, the hub router, and the Nostr
publisher is deferred. See `docs/privacy.md` for the construction,
caveats, and known leaks each layer does **not** address.
