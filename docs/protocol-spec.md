# pico protocol specification (v1)

> Status: **§0–§8 frozen** as of v1.1 (2026-05). Wire format and EIP-712 schemas
> in sections 0 through 8 are normative for v1 contracts, state-machine, SDK,
> hub, and watchtower. Changes to any field, type, or hash function in those
> sections require a protocol version bump in the EIP-712 domain (`version: '1'`
> → `'2'`).
>
> **§8 (inbound liquidity / `topUp`) is implemented as of v1.1.** The
> `PaymentChannel.sol` `topUp` and `closeUnilateralFromOpen` functions, the SDK
> `proposeTopUp` / `acceptTopUp` / `rejectTopUp` handshake, the hub
> `topup-policy` / `topup-handler` / `auto-recycle` pipeline, and the hub
> `closeCooperative` replay defenses (`version` + `validUntil` per §1) all
> ship together. The "Top-up" paragraph in §1 and the `Top-up integrity`
> bullet in §7 describe live behavior, not forward-references. End-to-end
> coverage of every numbered scenario in
> [`inbound-liquidity-scenarios.md`](./inbound-liquidity-scenarios.md) lives in
> `e2e/src/inbound-liquidity.scenarios.test.ts` (in-process, anvil-backed) plus
> the per-package suites listed in that file's scenario coverage matrix.

## 0. Conventions

- All on-chain timestamps are `uint64` seconds since the Unix epoch (`block.timestamp`).
- All off-chain timestamps use `Date.now()` in milliseconds and are bucketed to whole
  seconds (integer division by 1000) **before signing** any EIP-712 message. Signing
  milliseconds anywhere is a bug.
- All hashes are 32-byte values rendered as 0x-prefixed lowercase hex strings.
- `bytes32(0)` denotes `0x0000…0000` (32 zero bytes).
- Numeric values are unsigned `uint256` or `uint64` as typed; bigints in TypeScript.
- USDC has 6 decimals; `1 USDC = 1_000_000n` smallest units.
- All amounts in this spec are denominated in the **channel token's smallest
  unit**, not USDC base units. v1 contracts support any owner-allowlisted ERC-20
  *and* native ETH (signalled by `token == address(0)`, decimals = 18). The
  example values in this document use USDC because USDC is the v1 default; an
  ETH channel scales the same fields by 1e18 instead of 1e6.

## 1. Channel lifecycle

A channel transitions through these states:

```
   ┌───────┐  open()      ┌──────┐  update* / topUp*   ┌───────────────────────┐
   │ none  │ ───────────▶ │ open │ ──────────────────▶ │ closing-cooperative   │
   └───────┘              └──────┘     coop_close      └───────────────────────┘
                             │            ▲                       │
                             │            │                       ▼ finalize
                  unilateral │            │                   ┌────────┐
                       close │            │                   │ closed │
                             ▼            │                   └────────┘
                        ┌──────────┐      │                       ▲
                        │ disputed │ ─────┘ challenge / respond   │ finalize
                        └──────────┘ ──────────────────────────────┘
                                       (after dispute window)
```

**Contract-level status** (the on-chain enum in `PaymentChannel.sol`):

| Status | Meaning |
|--------|---------|
| `None` | No channel exists at this id |
| `Open` | Funded, accepting state updates and `topUp` |
| `ClosingUnilateral` | Some party submitted a state via `closeUnilateral`/`closeUnilateralFromOpen`; dispute window running |
| `Closed` | Funds disbursed; channel is final |

**SDK-level status** (additional observability in client / hub code; not part
of the on-chain enum):

| Status | Meaning |
|--------|---------|
| `pending` | On-chain `openChannel` tx submitted, not yet confirmed |
| `closing-cooperative` | Both parties signed a `CooperativeClose`; submission tx in flight |
| `disputed` | A counterparty challenged a unilateral close with a strictly-newer state |

The contract treats `closing-cooperative` and `disputed` as transient phases of
the on-chain lifecycle; they are tracked in SDK / hub state for UX clarity and
have no separate on-chain representation.

**Open**: a depositor calls `PaymentChannel.openChannel(userB, token, amountA, amountB)`
with `amountA + amountB ≥ minChannelAmount[token]`. The minimum is per-token,
owner-managed via `setMinChannelAmount`; v1 deploys seed `USDC = 10_000_000` (10
USDC) and, when `ENABLE_ETH=true`, `address(0) = 0.01 ether`. Tokens without a
configured floor default to `0`.

**v1 constraint: for ERC-20 channels, `amountB` MUST be `0`.** All dual-funded
patterns (in particular hub-provided inbound liquidity) go through `topUp` (§8).
Allowing `amountB > 0` in `openChannel` would let a third party drain a
counterparty's standing ERC-20 allowance during the brief window between
`approve` and `topUp`; rejecting it eliminates the attack class by
construction.

**ETH channels** (`token == address(0)`): the same `amountB == 0` rule applies,
plus the opener attaches `msg.value == amountA` (no `approve` step exists for
native ETH). Counterparty inbound liquidity is added later via `topUp` (`payable`,
`msg.value == amount`). Disbursements at `closeCooperative` and `finalize` use
`call{value:}`; if either participant is a contract whose `receive()` reverts,
the disbursement reverts and the channel is stuck. ETH channel counterparties
SHOULD be EOAs or contracts with a trivial `receive() external payable {}`.

**Unilateral close from initial state**: the on-chain `ChannelOpened` event
records the funded amounts, which together imply an "implicit version-0 state"
of `{balanceA: amountA, balanceB: amountB, htlcsRoot: 0, finalized: false}`.
Either party may call `closeUnilateralFromOpen(channelId)` immediately after
open without a counterparty signature; the contract uses the implicit
initial state and starts the dispute window. The counterparty can challenge
during the window with any strictly-newer dual-signed state. This guarantees
that a freshly-deposited user can always recover their funds even if the
counterparty refuses to co-sign any subsequent state.

**Update**: each balance change is a `ChannelState` (§2) signed by both parties
off-chain. No on-chain footprint unless dispute occurs.

**Top-up**: either party may add to their own deposit during a channel's `open`
phase by calling `PaymentChannel.topUp(channelId, amount, signedNewState)` (§8).
The transaction is gated by a co-signed `ChannelState` whose `balanceA` (or
`balanceB`) is increased by exactly `amount`, with `version = previous + 1`.
Top-up does not change channel `status`, but it bumps `amountA` or `amountB`
and updates the posted state snapshot. After unilateral close has been
initiated, top-up is rejected.

**Cooperative close**: both parties sign a `CooperativeClose` (§6) carrying the
final split, the `version` of the state being closed against, and a `validUntil`
deadline. Either submits it on-chain; funds disburse instantly.

The `version` and `validUntil` fields are **load-bearing replay defenses**:

- Without `version`, any past `CooperativeClose` whose final balances happen to
  coincide with a later legitimate split could be re-submitted to roll the
  channel back. Example: Alice and Hub sign a close `{finalA: 10, finalB: 0}`
  but never submit it. Alice later pays Hub 5 USDC directly. Without
  `version`, the old close still validates on-chain and erases the 5 USDC
  payment. The contract rejects a `CooperativeClose` whose `version` is not
  strictly greater than `channels[id].postedVersion`, blocking that replay.
- `validUntil` ensures stale close authorizations expire even if both parties
  forget about them. Default: 1 hour from `signedAt`. Implementations MAY
  choose shorter; the contract enforces `block.timestamp ≤ validUntil`.

**Unilateral close**: a party submits the latest dual-signed `ChannelState`. The
24-hour dispute window opens.

**Dispute**: during the window, the counterparty may submit a strictly newer
`ChannelState` (`version` field, §2). The contract replaces the state and restarts
the window. After the window closes with no challenge, anyone may call `finalize`,
which disburses balances. v1 does not reveal/refund in-flight HTLCs on-chain.

## 2. State updates

A `ChannelState` is the canonical authoritative state of a channel at a given version.

| Field | Type | Notes |
|-------|------|-------|
| `channelId` | `bytes32` | `keccak256(abi.encode(contract, userA, userB, token, openedAtSeconds, openNonce))`. `userA` is the `msg.sender` of `openChannel`. `openedAtSeconds` is the on-chain `block.timestamp` at open. `openNonce` is a per-contract monotonic counter (`PaymentChannel.openNonce`). The derivation is fixed by the deployed contract; off-chain code MUST match it byte-for-byte. |
| `version` | `uint64` | Strictly increasing per channel |
| `balanceA` | `uint256` | channel-token smallest-units owned by userA, *not* including in-flight HTLCs |
| `balanceB` | `uint256` | channel-token smallest-units owned by userB, *not* including in-flight HTLCs |
| `htlcsRoot` | `bytes32` | Merkle root over the in-flight HTLC set (§3) |
| `finalized` | `bool` | Set true on cooperative close; rejects further updates |

**Invariants:**

- Balance conservation: `balanceA + balanceB + Σ(htlc.amount)` is constant across
  every transition for a given channel.
- Conservation under top-ups: when `amountA` or `amountB` is increased via
  `topUp` (§8), the conservation sum on subsequent states becomes
  `balanceA + balanceB + Σ(htlc.amount) = amountA + amountB` evaluated against
  the **post-top-up amounts**. The atomic top-up tx (§8) requires the new state
  to assert this equality; subsequent updates must continue to satisfy it.
  States signed against the pre-top-up amounts cannot be posted on-chain after
  the top-up confirms because they fail the conservation check against the new
  amounts.
- Monotonicity: any new state must satisfy `next.version > prev.version`.
- A state with `finalized = true` is terminal off-chain; the state machine rejects any
  further updates.

**Signing**: a `ChannelState` is signed via EIP-712 (§6). A state is *valid* off-chain
only when accompanied by signatures from **both** userA and userB.

**Update wrapper**: when transmitting a state change, parties exchange an `Update`
message containing `(channelId, fromVersion, toVersion, nextState)` signed via EIP-712
`Update` typed-data (§6). The wrapper proves intent to transition from a specific
prior version, defending against state-skip attacks.

The `Update` wrapper is an **off-chain admission rule**: the SDK (in
`packages/sdk/`) and the hub WS handlers (in `apps/hub/src/api/`) both verify
it before accepting a state into local storage or the channel pool. The
`PaymentChannel` and `Adjudicator` contracts only verify the inner
`ChannelState` typed-data; they do not consult the `Update` wrapper. This
keeps gas costs down at the cost of requiring every off-chain implementer to
enforce the wrapper rule. The wrapper SHOULD be persisted alongside the
state for audit and dispute reconstruction, even though the contract does
not require it.

## 3. HTLC

HTLCs (Hash Time-Locked Contracts) enable atomic multi-hop routing through the hub
without requiring trust.

### 3.1 Hash function

The HTLC hashlock uses **SHA-256**:

```
preimage: bytes32        (random 32 bytes chosen by the recipient)
paymentHash: bytes32 = sha256(preimage)
```

Rationale: SHA-256 matches Lightning Network conventions, simplifying future bridge
work. The ~700 gas premium over keccak256 is negligible — on-chain HTLC reveals occur
only during disputes (rare).

### 3.2 HTLC fields

| Field | TypeScript type | EIP-712 type | Notes |
|-------|-----------------|--------------|-------|
| `id` | `Hex` | `bytes32` | Unique per channel; chosen by sender |
| `amount` | `bigint` | `uint256` | Channel-token smallest-units, ≤ sender's free balance |
| `paymentHash` | `Hex` | `bytes32` | `sha256(preimage)` |
| `expiryMs` (off-chain) / `expiry` (on-chain) | `bigint` | `uint64` | Off-chain ms; bucketed to seconds before signing/hashing |
| `direction` | `'AtoB' \| 'BtoA'` | `uint8` | `'AtoB' = 0`, `'BtoA' = 1` |

### 3.3 Lifecycle

```
   add  ───▶  pending  ───▶  settle (preimage revealed)  ───▶  removed
                  │
                  ├─▶  fail (counterparty rejects)         ───▶  removed
                  └─▶  expire (now ≥ expiry)               ───▶  removed
```

- **add**: sender's balance is deducted by `amount`; HTLC inserted into the set.
- **settle**: counterparty reveals a preimage `s` with `sha256(s) == paymentHash`;
  receiver credited; HTLC removed.
- **fail**: explicit cancel; sender refunded; HTLC removed.
- **expire**: any party may invoke after `now ≥ expiry`; sender refunded.

> **Safety note (v1)**: each transition above is an off-chain co-signed state
> update. Because v1 has no on-chain HTLC settlement (§5.4), any of these
> transitions is only safe to rely on while both parties remain live. If a
> dispute is initiated while `htlcsRoot != 0`, the contract cannot adjudicate
> the in-flight HTLCs and they revert to the empty-root state. This is the
> reason v1 caps in-flight exposure (§4.3).

### 3.4 HTLC root algorithm (Merkle)

The `htlcsRoot` field on `ChannelState` commits to the entire in-flight HTLC set:

```
htlcsRoot = htlcMerkleRoot(htlcs)
```

**Algorithm** (identical in TypeScript `@inferenceroom/pico-protocol/htlc-root.ts` and Solidity
`Adjudicator.htlcRootOf`):

1. **Empty set**: return `bytes32(0)`.
2. **Sort** the HTLC array by `id` ascending (lex byte order).
3. **Leaf hash** each HTLC: `keccak256(abi.encode(id, amount, paymentHash, expirySec, direction))`.
4. **Build tree bottom-up**: pair adjacent leaves; if a level has odd count, duplicate
   the last node before pairing. Inner node = `keccak256(left ++ right)` where `++` is
   raw 64-byte concatenation.
5. Return the single remaining node as the root.

**Worked example** with 3 HTLCs (sorted by id: `h0`, `h1`, `h2`):

```
level 0 (leaves):     L0 = leaf(h0)   L1 = leaf(h1)   L2 = leaf(h2)
level 1 (pairs):      P0 = keccak256(L0 || L1)        P1 = keccak256(L2 || L2)
level 2 (root):       R  = keccak256(P0 || P1)
```

> **Note**: v1 uses Merkle even though typical channels carry ≤ 5 in-flight HTLCs
> (where sorted-keccak-concat would suffice). Merkle is locked in to permit future
> single-HTLC inclusion proofs without a protocol bump.

## 4. Routing

Topology: 1-hop hub-and-spoke.

```
   userA  ─── channel A ───▶  hub  ─── channel B ───▶  userB
```

### 4.1 Atomic settlement

To send `amount` from A to B atomically:

1. B picks a 32-byte preimage `s`, computes `paymentHash = sha256(s)`, sends
   `paymentHash` to A out-of-band.
2. A adds an HTLC on channel A: `(amount + hubFee, paymentHash, expiry = T_outer, AtoB)`.
3. Hub adds an HTLC on channel B: `(amount, paymentHash, expiry = T_inner, AtoB)`,
   where `T_inner < T_outer` by at least one block confirmation safety margin
   (default: T_outer = now + 1h, T_inner = T_outer - 30 min).
4. B reveals `s` to settle the channel-B HTLC, receiving `amount`.
5. Hub now knows `s`; reveals it to A on channel A to claim `amount + hubFee`.

If anyone disappears mid-flight, expiry refunds funds to the originator on each leg.
The shorter `T_inner` ensures the hub cannot be left in a state where it has paid B
but cannot claim from A.

### 4.2 Hub fees (`FlatPlusBpsFeePolicy`)

For payment of `amount`:

```
fee = floor(amount * DEFAULT_HUB_FEE_BPS / 10_000) + DEFAULT_HUB_FEE_FLAT
    = floor(amount * 10n / 10_000n) + 1n
    = 0.10% of amount + 1 unit
```

Sender HTLC amount = `amount + fee`. Hub HTLC amount = `amount`. Fee = retained by hub.

### 4.3 Refusal conditions and exposure caps

Hub refuses to forward when any of the following hold:

- Hub side balance < `amount`
- Channel B in-flight HTLC count would exceed `MAX_HTLCS_PER_CHANNEL` (default `5`).
- Total in-flight HTLC value on Channel B would exceed `MAX_HTLC_VALUE_PER_CHANNEL`
  (default: `min(amountA, amountB)` of Channel B; in plain English, an HTLC may
  not lock more than the smaller side of the channel).
- Aggregate in-flight HTLC value across **all channels with the same
  counterparty** exceeds `MAX_HTLC_VALUE_PER_COUNTERPARTY` (default `100 USDC`).
- HTLC `expiry - now` < `MIN_HTLC_DURATION` (default `15 minutes`).
- HTLC `expiry - now` > `MAX_HTLC_DURATION` (default `2 hours`).
- `T_outer - T_inner` < `HTLC_TIMEOUT_DELTA` (default `30 minutes`; covers Taiko
  finality + RPC latency + watchtower retry budget).
- Receiver channel B is not `open`.

These defaults are normative for v1 reference implementations of the hub. Hubs
MAY tighten any cap; hubs MUST NOT loosen `MIN_HTLC_DURATION`,
`HTLC_TIMEOUT_DELTA`, or `MAX_HTLC_DURATION` without a protocol version bump,
because looser timing assumptions invalidate watchtower deployments.

## 5. Dispute resolution

### 5.1 Dispute window

`DISPUTE_WINDOW = 24 hours` (immutable contract constant).

### 5.2 Unilateral close flow

There are two entry points, depending on whether any dual-signed state has been
exchanged yet:

**Standard close (post-update)**:

1. Party calls `PaymentChannel.closeUnilateral(state, sigA, sigB)` with the latest
   dual-signed `ChannelState`. `state.htlcsRoot` MUST be `bytes32(0)` (see §5.4).
2. Contract verifies both signatures via EIP-712, records `(state, deadline = now + 24h)`.
3. Channel transitions to `closing-unilateral`.

**Close from initial state (pre-update)**:

1. Party calls `PaymentChannel.closeUnilateralFromOpen(channelId)` with no signed
   state.
2. Contract requires `status == open` and `postedVersion == 0` (i.e., no later
   state has been posted). It synthesizes the implicit initial state from
   `(amountA, amountB, htlcsRoot=0, version=0)` and records
   `(state, deadline = now + 24h)`.
3. Channel transitions to `closing-unilateral`.

This second path defends against a counterparty that refuses to co-sign any
state after the open. The counterparty can still challenge with a strictly-newer
dual-signed state during the 24-hour window via §5.3.

### 5.3 Challenge

During the window, the counterparty (or any third-party watchtower) may submit a
strictly-newer dual-signed state. The contract replaces the recorded state and, on the
**first** successful challenge, restarts the 24-hour window. Repeated challenge/
counter-challenge is permitted as long as each new submission has a strictly higher
`version`, but the deadline only restarts once — subsequent challenges bump
`postedVersion` without extending `disputeDeadline`.

A successful challenge is implicit proof that the closer posted a stale state — a
strictly-newer state that *both* parties already signed existed at close time. The
contract therefore marks the channel `penalized` on every successful `dispute()` (and
on `submitPenaltyProof`), and `finalize` disburses 100% of the pot to the non-closing
party. Without this rule the closer could front-run a watchtower's penalty proof by
self-calling `dispute` (or hiring any third party) with the latest dual-signed state,
bumping `postedVersion` past the proof's required threshold and escaping the slash.
The one-shot deadline restart prevents a complementary griefing path: once `penalized`
is set, the slash outcome is locked in, so further disputes cannot affect the payout
and must not be allowed to delay `finalize` for the honest party.

### 5.4 HTLC handling (v1 trust-liveness limitation)

v1 does **not** implement on-chain HTLC claim/refund during disputes. The contracts
reject any `ChannelState` with a non-empty `htlcsRoot` in unilateral close, dispute,
and penalty paths. Cooperative close signs a `CooperativeClose` artifact without an
HTLC root, so clients and hubs MUST only request it after all HTLCs settle or fail.

> **Important: this is a trusted-liveness assumption, not a fully trustless
> design.** Mid-flight HTLC sequences are not safe against an adversarial
> counterparty. Two specific attack patterns are visible:
>
> 1. *Adversary closes with a stale empty-root state.* The honest party's most
>    recent dual-signed state has a non-empty `htlcsRoot` and therefore cannot
>    be posted as a challenge during the dispute window. The contract resolves
>    against the older empty-root state, ignoring the in-flight HTLC.
> 2. *Honest party closes with the latest empty-root state and an in-flight
>    HTLC has not yet been resolved.* The HTLC's value silently reverts to the
>    sender at close time on-chain even if the receiver had already revealed
>    a preimage off-chain.
>
> The mitigations in v1 are operational, not protocol-level:
> - Clients and hubs MUST NOT initiate `closeUnilateral` while
>   `htlcsRoot != 0` on the latest local state.
> - Watchtowers MUST monitor for stale-empty-root closes and post the most
>   recent dual-signed empty-root state as a challenge if available.
> - Hub admission policy SHOULD cap maximum in-flight HTLC count and total
>   in-flight value per channel and per counterparty (see §4.3).
>
> Mainnet v1 deployments SHOULD set conservative caps until on-chain HTLC
> settlement is added in a future protocol version.

On-chain HTLC settlement (Merkle proof verification, preimage claims, expiry refunds)
is the most important post-v1 protocol upgrade and is tracked as the headline
v1.x → v2 milestone.

### 5.5 Finalize

After `now > deadline`, anyone calls `finalize()`. Funds disburse to A and B per the
final balances.

### 5.6 Watchtower

An external watchtower service holds the latest dual-signed state for a user. If the
counterparty submits a stale state and the user is offline, the watchtower posts the
newer state during the window, blocking the steal. See `docs/threat-model.md`
§ Watchtower offline.

## 6. Wire format

### 6.1 EIP-712 domain

```ts
{
  name: 'pico',
  version: '1',
  chainId: 167000 | 167009,   // Taiko mainnet | Hoodi (typed support; see note)
  verifyingContract: <Adjudicator address>,
}
```

The `version: '1'` field is the **protocol version byte** (per EIP-712 conventions,
it is a string but functionally identical). Signatures from a v1 deployment will not
verify against a v2 contract and vice versa, providing replay protection across
protocol upgrades.

**Hoodi note**: chainId `167009` is permitted by the EIP-712 type but is **not
in the v1 production `SUPPORTED_CHAIN_IDS`** (see `packages/protocol/src/constants.ts`)
because the v1 contract addresses and USDC token are not yet deployed on Hoodi.
Implementations targeting Hoodi for testing must deploy contracts and update the
constants module before signatures are accepted by tooling that consults
`SUPPORTED_CHAIN_IDS`.

### 6.2 Typed-data variants

| primaryType | Fields | Used for |
|-------------|--------|----------|
| `ChannelState` | `channelId, version, balanceA, balanceB, htlcsRoot, finalized` | The canonical signed state |
| `Htlc` | `id, amount, paymentHash, expiry, direction` | Standalone HTLC commitment |
| `Update` | `channelId, fromVersion, toVersion, nextState: ChannelState` | Transition wrapper proving prev→next intent |
| `CooperativeClose` | `channelId, version, finalBalanceA, finalBalanceB, signedAt, validUntil` | Cooperative-close authorization. `version` MUST be strictly greater than the channel's on-chain `postedVersion`. `validUntil` is a `uint64` Unix-second deadline; the contract rejects when `block.timestamp > validUntil`. |

Field encodings follow EIP-712 standard: `bytes32`, `uint64`, `uint256`, `uint8`,
`bool`, and nested struct (`ChannelState` inside `Update`).

### 6.3 Transport

Off-chain messages are exchanged as JSON envelopes over the hub WebSocket. The Nostr
event-kind range `30401–30420` is reserved for pico events; current allocations:

| Kind | Name |
|------|------|
| 30401 | PaymentQuote |
| 30402 | PaymentInvoice |
| 30403 | PaymentReceipt |
| 30404 | ChannelOpenAd |
| 30405 | ChannelInfo |
| 30406 | HubAd |
| 30407 | HubStatus |
| 30408 | DvmPaymentOption |

## 7. Security considerations

See `docs/threat-model.md` for full adversary models. Headline assumptions:

- **State backup**: each party MUST persist the latest dual-signed `ChannelState`
  before considering an update final. Loss-of-state defaults to disadvantage in
  dispute.
- **Watchtower availability**: the protocol's safety against a malicious counterparty
  during user offline-periods relies on a watchtower being able to post during the
  24-hour window. A watchtower reachable from at least one well-connected RPC suffices.
- **Replay protection**: EIP-712 domain `version: '1'` + `chainId` + `verifyingContract`
  uniquely scope every signature.
- **Eclipse / relay layer**: hub WebSocket compromise does not endanger funds (HTLCs
  prevent theft) but can stall payments; clients should track multiple Nostr relays.
- **Chain reorg**: applications wait `≥ 12 blocks` (Taiko safety boundary) before
  considering `open` or `finalize` final. Reorgs deeper than that are out of scope.
- **Fee griefing**: the per-token `minChannelAmount` floor (default 10 USDC for
  USDC channels, 0.01 ETH for ETH channels) deters dust channels whose
  open/close gas exceeds value. The flat hub fee `1` unit deters zero-amount
  griefing through the hub.
- **Top-up integrity**: `topUp` (§8) requires both `sigA` and `sigB` on the new
  state and pulls funds from `msg.sender` only — neither party can unilaterally
  inflate the other's deposit, and neither party can withdraw the other's funds.
  A malicious hub that signs a top-up offer but never submits the on-chain tx
  merely fails to provide promised inbound liquidity; no user funds are at risk.
- **Slashing-persistence ordering**: §5.3 imposes a 100% slash on any successful
  dispute. This requires that **a state is considered final only after both
  parties have durably persisted both signatures**. Implementations MUST ensure
  the order is: receive counterparty sig → durably persist the fully co-signed
  state → emit any user-visible "settled" acknowledgement. Sending an ack before
  a successful fsync (or DB commit) on the latest dual-signed state risks
  losing access to the most recent state on crash, which under the current
  slash rule means losing the entire channel pot. This rule is being kept
  conservative in v1 to close a front-run gap; future revisions should consider
  a softer penalty model that doesn't punish honest persistence-loss. Until
  then, channel caps (§7 fee griefing bullet) bound the worst-case loss.

## 8. Inbound liquidity (`topUp`)

### 8.1 Motivation

Pico's routing (§4) requires the hub to have positive outbound balance in the
channel between the hub and the recipient. Channels opened via `openChannel`
(§1) have `amountB = 0` in the LSP model — the hub has no outbound. To enable
Alice → Hub → Bob flows, the hub must add to its side of Bob's channel after
open. `topUp` is that primitive.

### 8.2 Function signature

```solidity
function topUp(
    bytes32 channelId,
    uint256 amount,
    SignedChannelState calldata prevState,
    SignedChannelState calldata newState
) external nonReentrant;
```

`SignedChannelState` is the existing `(state, sigA, sigB)` tuple used by
unilateral close. The contract verifies signatures on **both** `prevState` and
`newState`, anchoring the top-up against the latest off-chain state the parties
have agreed on rather than against the (potentially stale) on-chain
`postedVersion`. This is essential because ordinary off-chain payments do not
update on-chain state; without `prevState`, a top-up could roll the channel
back to old balances while increasing total capacity.

### 8.3 Semantics

When called by `msg.sender`:

1. Channel must exist with `status == open`.
2. `msg.sender` MUST be `userA` or `userB` (the depositor).
3. **`prevState` validation**:
   - `prevState.channelId == channelId`.
   - `prevState.state.htlcsRoot == bytes32(0)` (no in-flight HTLCs).
   - `prevState.state.finalized == false`.
   - `prevState.state.version >= channel.postedVersion`. This prevents using
     an outdated `prevState` to mask a recent dispute close.
   - Both `sigA` and `sigB` on `prevState` MUST verify.
   - Conservation against current on-chain amounts:
     `prevState.balanceA + prevState.balanceB == channel.amountA + channel.amountB`.
   - For the very first top-up on a freshly-opened channel that has no
     dual-signed state yet, the special sentinel value `prevState = (state with
     version=0, balanceA=amountA, balanceB=amountB, htlcsRoot=0, finalized=false,
     sigA=ZERO_SIG, sigB=ZERO_SIG)` is accepted. Both signatures are skipped
     for this sentinel; the contract trusts the implicit on-chain state.
4. **`newState` validation**:
   - `newState.channelId == channelId`.
   - `newState.state.version == prevState.state.version + 1`.
   - `newState.state.htlcsRoot == bytes32(0)`.
   - `newState.state.finalized == false`.
   - Only `msg.sender`'s balance increases by exactly `amount`; the
     counterparty's balance is unchanged from `prevState`:
     - if `msg.sender == userA`: `newState.balanceA == prevState.balanceA + amount`,
       `newState.balanceB == prevState.balanceB`.
     - if `msg.sender == userB`: `newState.balanceB == prevState.balanceB + amount`,
       `newState.balanceA == prevState.balanceA`.
   - Conservation against post-top-up amounts:
     `newState.balanceA + newState.balanceB == channel.amountA + channel.amountB + amount`.
   - Both `sigA` and `sigB` on `newState` MUST verify.
5. Contract pulls `amount` of the channel's `token` from `msg.sender` via
   `safeTransferFrom`. Caller must have approved PaymentChannel beforehand.
6. Contract increments `channel.amountA` or `channel.amountB` by `amount`.
7. Contract updates the posted-state snapshot to `newState`
   (`postedVersion`, `postedBalanceA`, `postedBalanceB`).
8. Emits `ToppedUp(channelId, msg.sender, amount, newVersion)`.

### 8.4 Why `prevState` is required

Without `prevState`, the spec would have to anchor `newState` against
`channel.postedVersion` and the corresponding posted balances. But ordinary
off-chain payments do not update on-chain state, so the on-chain posted
snapshot is typically stale (often just the implicit version-0 state from
open). Two failure modes follow:

- **Refill of an active channel** is impossible. After Alice and Hub have
  exchanged 20 versions of off-chain state, `channel.postedVersion` is still
  0 on-chain. A top-up that requires `newState.version == postedVersion + 1`
  would produce a state with `version = 1`, which is older than every
  off-chain state both parties hold and would silently roll balances back.
- **Auto-recycle into an under-provisioned channel** has the same failure
  mode: any top-up of a channel that has seen payments would roll back the
  payment history.

By taking `prevState` as input, the contract verifies the latest off-chain
state both parties co-signed and uses *its* balances as the baseline for the
new state. Subsequent disputes cannot use any state with `version <
prevState.version + 1`, so the top-up's history is preserved.

### 8.5 Constraints

- `topUp` is rejected when `status != open`. In particular, after
  `closeUnilateral` has been called, no further top-ups are accepted.
- `topUp` is rejected when either `prevState.htlcsRoot` or
  `newState.htlcsRoot` is non-zero. Top-ups must occur between payments,
  not during in-flight HTLC sequences.
- `topUp` is rejected when `prevState.finalized == true`.
- Per-counterparty and per-channel deposit caps SHOULD be enforced by the
  hub's admission policy (off-chain). The contract itself only checks the
  network-wide limits (`channel_participant_deposit_limit`, etc.).

### 8.6 Off-chain handshake (recommended for hubs)

When the hub auto-detects a new `ChannelOpened` event with `userB == hub` and
its admission policy decides to provide inbound liquidity, the hub initiates a
WS handshake with the user before submitting the on-chain `topUp` tx.

The handshake follows the LSPS2 / bLIP-52 pattern: the hub publishes a
**bounded, time-limited, signed offer**; the user accepts it with their own
signature; the hub then submits the on-chain tx within the offer's validity
window. Without these terms, a stale or replayed offer could surprise a user
who has continued transacting, and a delayed submission could invalidate
later off-chain states.

#### Message kinds

| Direction | Kind | Payload |
|---|---|---|
| hub → user | `proposeTopUp` | offer envelope (below), hub-signed |
| user → hub | `acceptTopUp` | `{ channelId, offerId, signedNewState }` |
| user → hub | `rejectTopUp` | `{ channelId, offerId, reason }` |

#### `proposeTopUp` offer envelope

| Field | Type | Notes |
|---|---|---|
| `kind` | string | `"proposeTopUp"` |
| `channelId` | bytes32 | The user's channel with the hub. |
| `offerId` | bytes32 | Random per-offer; user signs over this so the offer cannot be re-used for a different top-up. |
| `amount` | uint256 | USDC base units the hub will deposit. |
| `prevStateVersion` | uint64 | The off-chain state version the hub assumes is the latest dual-signed state with `htlcsRoot == 0`. The user MUST verify their local latest co-signed state matches before accepting. |
| `newState` | ChannelState | The proposed `version+1` state with `balanceB += amount` (or `balanceA += amount` for hub-as-userA channels), all other fields preserved. |
| `validUntil` | uint64 | Unix-second deadline. Hub MUST submit the on-chain tx before this time, or the offer is void. The user MUST refuse late-arriving accepts beyond this time. |
| `feePolicy` | object \| null | If hub charges a top-up fee, the fee schedule (flat + bps). If `null`, the top-up is free. |
| `minLifetime` | uint64 \| null | If set, the hub commits not to initiate `closeUnilateral` on this channel before `now + minLifetime`. Mirrors LSPS2 minimum-channel-lifetime. |
| `maxInFlightHtlcs` | uint16 | The max in-flight HTLC count the hub will accept while this top-up is in effect; informs client routing limits (§4.3). |
| `partialAccepted` | bool | Whether the user may accept a smaller `amount` (anti-probing nicety; v1 hubs MAY reject all probes). |
| `prevSig` | bytes | Hub's signature (sigB if hub is userB, sigA if hub is userA) on the LATEST dual-signed state — needed by the user to confirm the hub agrees on the prev-state baseline. |
| `newSig` | bytes | Hub's signature on `newState`. |

The user, on receiving `proposeTopUp`:

1. Verifies their local latest co-signed state matches `prevStateVersion` and
   the balances implied by `newState` minus `amount`.
2. Verifies `validUntil` is not already past.
3. Verifies `feePolicy` and `minLifetime` are acceptable.
4. Signs `newState` with `sigA`, signs `offerId` separately as an
   acknowledgement, and returns `acceptTopUp { channelId, offerId,
   signedNewState }`.

Upon receiving `acceptTopUp`, the hub MUST submit the on-chain `topUp(...)`
tx within `validUntil`. If the hub misses the deadline, both sides discard
the offer; the channel remains at its current `amountB`.

`rejectTopUp` is purely informational: the user signed nothing, the hub
withdraws the offer.

#### Anti-probing and offer rate-limiting

To prevent attackers from harvesting hub liquidity terms without intent to
pay, hubs SHOULD rate-limit `proposeTopUp` per IP / per address and SHOULD
NOT treat every observed `ChannelOpened` as automatic eligibility.

#### Failure modes summary

- **Hub crashes between propose and submit**: the offer expires at
  `validUntil`. No funds at risk.
- **User signs but disconnects**: hub still has the user's signature and may
  submit on-chain within `validUntil`. The user gets the inbound liquidity.
- **Hub submits on-chain but user disconnects**: chain-watcher catches up
  the user's local state on reconnect.
- **Two simultaneous offers (re-prompt)**: each carries a unique `offerId`;
  the user accepts only one. The other expires at its `validUntil`.

### 8.7 Settlement implications

Cooperative close and unilateral close already compute final balances from a
co-signed `ChannelState` and dispatch funds via `amountA + amountB`. Because
`topUp` updates `amountA`/`amountB` atomically with the posted state, the
existing close paths require **no change** — they already use the channel's
current amounts, which reflect any top-ups that have occurred.

### 8.8 Inbound auto-recycle on close (RECOMMENDED hub behavior)

When a channel that the hub has topped up cooperatively closes, the hub's
recovered share (`finalBalanceB` for hub-as-userB, or `finalBalanceA` for
hub-as-userA) returns to the hub's hot wallet on-chain. A conformant hub
SHOULD use that recovered USDC immediately to provision inbound liquidity for
**another** queued or under-provisioned channel, recycling capital across
counterparties without an idle period.

**Trigger**: `ChannelClosedCooperative` (or `ChannelFinalized` after a unilateral
close) event observed by the hub's chain-watcher with `userB == hub` (or
`userA == hub`) and a non-zero hub-side final balance.

**Decision input** (hub-internal queue, off-chain):

- A FIFO list of pending top-up requests (e.g., users whose recent
  `ChannelOpened` was rejected by admission policy due to insufficient
  hot-wallet headroom).
- Existing live channels whose hub-side outbound has fallen below a refill
  threshold (e.g., `balanceB < channel.amountB / 4`).

**Action**: pick the highest-priority candidate, run the standard `proposeTopUp`
handshake (§8.6), submit `topUp(...)`. The recovered USDC is the same on-chain
USDC that just landed in the hub's wallet, so no fresh deposit from external
sources is required.

**Why this is RECOMMENDED, not REQUIRED**: it is purely a hub-operational
optimization. The protocol works correctly without it (recovered USDC simply
sits in the hub's hot wallet until used). Documenting it in the spec gives
implementers a clear mental model and ensures interoperability of fee
expectations between hubs and clients.

**Limits**: the hub MUST NOT use auto-recycle to bypass the per-counterparty
deposit cap (§8.5) or to commit funds it has already promised to another
in-flight `proposeTopUp`. Concurrency is serialized via the same hot-wallet
mutex used for `topUp` (Scenario 12 of `inbound-liquidity-scenarios.md`).

### 8.9 Splicing (v1.5)

A symmetric `spliceOut(channelId, amount, newState)` function permits a party
to **withdraw** part of their deposit during a channel's life, gated by a
co-signed state where their balance decreases by `amount`. This is deferred
to v1.5; the topUp construction is forward-compatible.

## See also

- [`inbound-liquidity-scenarios.md`](./inbound-liquidity-scenarios.md) —
  step-by-step on-chain/off-chain walkthroughs of every flow described in this
  spec, including channel open, payDirect, routing, cooperative close, top-up,
  inbound auto-recycle, and attempted attacks.
