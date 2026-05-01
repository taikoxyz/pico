# tainnel protocol specification (v1)

> Status: **frozen** as of P1 (2026-04). Wire format and EIP-712 schemas in this
> document are normative for v1 contracts, state-machine, SDK, hub, and watchtower.
> Changes to any field, type, or hash function require a protocol version bump in
> the EIP-712 domain (`version: '1'` → `'2'`).

## 0. Conventions

- All on-chain timestamps are `uint64` seconds since the Unix epoch (`block.timestamp`).
- All off-chain timestamps use `Date.now()` in milliseconds and are bucketed to whole
  seconds (integer division by 1000) **before signing** any EIP-712 message. Signing
  milliseconds anywhere is a bug.
- All hashes are 32-byte values rendered as 0x-prefixed lowercase hex strings.
- `bytes32(0)` denotes `0x0000…0000` (32 zero bytes).
- Numeric values are unsigned `uint256` or `uint64` as typed; bigints in TypeScript.
- USDC has 6 decimals; `1 USDC = 1_000_000n` smallest units.

## 1. Channel lifecycle

A channel transitions through these states:

```
   ┌───────┐  open()      ┌──────┐   update*       ┌───────────────────────┐
   │ none  │ ───────────▶ │ open │ ──────────────▶ │ closing-cooperative   │
   └───────┘              └──────┘     coop_close   └───────────────────────┘
                             │            ▲                    │
                             │            │                    ▼ finalize
                  unilateral │            │                ┌────────┐
                       close │            │                │ closed │
                             ▼            │                └────────┘
                        ┌──────────┐      │                    ▲
                        │ disputed │ ─────┘ challenge / respond │ finalize
                        └──────────┘ ────────────────────────────┘
                                       (after dispute window)
```

| Status | Meaning |
|--------|---------|
| `pending` | On-chain `open` tx submitted, not yet confirmed |
| `open` | Funded, accepting state updates |
| `closing-cooperative` | Both parties signed a `CooperativeClose` |
| `closing-unilateral` | One party submitted last-known state on-chain |
| `disputed` | Counterparty challenged with newer state during dispute window |
| `closed` | Funds disbursed; channel is final |

**Open**: a depositor calls `PaymentChannel.open(userA, userB, token, amount)` with
`amount ≥ MIN_CHANNEL_AMOUNT_USDC = 10_000_000` (= 10 USDC).

**Update**: each balance change is a `ChannelState` (§2) signed by both parties
off-chain. No on-chain footprint unless dispute occurs.

**Cooperative close**: both parties sign a `CooperativeClose` (§6) carrying the final
split. Either submits it on-chain; funds disburse instantly.

**Unilateral close**: a party submits the latest dual-signed `ChannelState`. The
24-hour dispute window opens.

**Dispute**: during the window, the counterparty may submit a strictly newer
`ChannelState` (`version` field, §2). The contract replaces the state and restarts
the window. After the window closes with no challenge, anyone may call `finalize`,
which disburses balances and reveals/refunds any in-flight HTLCs.

## 2. State updates

A `ChannelState` is the canonical authoritative state of a channel at a given version.

| Field | Type | Notes |
|-------|------|-------|
| `channelId` | `bytes32` | `keccak256(abi.encode(contract, userA, userB, salt))` |
| `version` | `uint64` | Strictly increasing per channel |
| `balanceA` | `uint256` | USDC smallest-units owned by userA, *not* including in-flight HTLCs |
| `balanceB` | `uint256` | USDC smallest-units owned by userB, *not* including in-flight HTLCs |
| `htlcsRoot` | `bytes32` | Merkle root over the in-flight HTLC set (§3) |
| `finalized` | `bool` | Set true on cooperative close; rejects further updates |

**Invariants:**

- Balance conservation: `balanceA + balanceB + Σ(htlc.amount)` is constant across
  every transition for a given channel.
- Monotonicity: any new state must satisfy `next.version > prev.version`.
- A state with `finalized = true` is terminal off-chain; the state machine rejects any
  further updates.

**Signing**: a `ChannelState` is signed via EIP-712 (§6). A state is *valid* off-chain
only when accompanied by signatures from **both** userA and userB.

**Update wrapper**: when transmitting a state change, parties exchange an `Update`
message containing `(channelId, fromVersion, toVersion, nextState)` signed via EIP-712
`Update` typed-data (§6). The wrapper proves intent to transition from a specific
prior version, defending against state-skip attacks.

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
| `amount` | `bigint` | `uint256` | USDC smallest-units, ≤ sender's free balance |
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

### 3.4 HTLC root algorithm (Merkle)

The `htlcsRoot` field on `ChannelState` commits to the entire in-flight HTLC set:

```
htlcsRoot = htlcMerkleRoot(htlcs)
```

**Algorithm** (identical in TypeScript `@tainnel/protocol/htlc-root.ts` and Solidity
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

### 4.3 Refusal conditions

Hub refuses to forward when:
- Hub side balance < `amount`
- Channel B in-flight HTLC count would exceed implementation limit (recommended ≤ 5)
- `T_outer - T_inner` < safety margin (sender misconfigured timeouts)
- Receiver channel B is not `open`

## 5. Dispute resolution

### 5.1 Dispute window

`DISPUTE_WINDOW = 24 hours` (immutable contract constant).

### 5.2 Unilateral close flow

1. Party calls `PaymentChannel.closeUnilateral(state, sigA, sigB)` with the latest
   dual-signed `ChannelState`.
2. Contract verifies both signatures via EIP-712, records `(state, deadline = now + 24h)`.
3. Channel transitions to `closing-unilateral`.

### 5.3 Challenge

During the window, the counterparty may submit a strictly-newer dual-signed state.
The contract replaces the recorded state and **restarts** the 24-hour window.
Repeated challenge/counter-challenge is permitted as long as each new submission has
a strictly higher `version`.

### 5.4 HTLC handling (v1 limitation)

v1 does **not** implement on-chain HTLC claim/refund during disputes. The contracts
reject any `ChannelState` with a non-empty `htlcsRoot` in all close, dispute, and
penalty paths. This is a conscious simplification for the 1-hop dogfood scope: HTLCs
only live inside a single payment, and any close happens between payments. Clients
and watchtowers MUST ensure no close/dispute is initiated while `htlcsRoot != 0`.

On-chain HTLC settlement (Merkle proof verification, preimage claims, expiry refunds)
is deferred to a future protocol version.

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
  name: 'tainnel',
  version: '1',
  chainId: 167000 | 167009,   // Taiko mainnet | Hoodi
  verifyingContract: <Adjudicator address>,
}
```

The `version: '1'` field is the **protocol version byte** (per EIP-712 conventions,
it is a string but functionally identical). Signatures from a v1 deployment will not
verify against a v2 contract and vice versa, providing replay protection across
protocol upgrades.

### 6.2 Typed-data variants

| primaryType | Fields | Used for |
|-------------|--------|----------|
| `ChannelState` | `channelId, version, balanceA, balanceB, htlcsRoot, finalized` | The canonical signed state |
| `Htlc` | `id, amount, paymentHash, expiry, direction` | Standalone HTLC commitment |
| `Update` | `channelId, fromVersion, toVersion, nextState: ChannelState` | Transition wrapper proving prev→next intent |
| `CooperativeClose` | `channelId, finalBalanceA, finalBalanceB, signedAt` | Cooperative-close authorization |

Field encodings follow EIP-712 standard: `bytes32`, `uint64`, `uint256`, `uint8`,
`bool`, and nested struct (`ChannelState` inside `Update`).

### 6.3 Transport

Off-chain messages are exchanged as JSON envelopes over the hub WebSocket. The Nostr
event-kind range `30401–30420` is reserved for tainnel events; current allocations:

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
- **Fee griefing**: minimum channel `10 USDC` deters dust channels whose open/close
  gas exceeds value. The flat hub fee `1` unit deters zero-amount griefing through
  the hub.
