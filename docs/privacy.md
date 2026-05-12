# Privacy posture (v1.x scaffolding)

> Status: **groundwork**. The helpers documented here ship in the SDK,
> state-machine, and hub fee policy as of this PR. End-to-end wiring
> (per-channel stealth signers in `ChannelClient`, hub bucketing in the
> router, PTLC contract path) is deferred to subsequent PRs.

## 0. What pico's 1-hop topology does NOT protect

The hub is the sole intermediary on every payment. By construction it
observes:

- the sender's on-chain `userA` address (signed counterparty),
- the recipient's on-chain `userB` address (signed counterparty),
- the exact `amount`,
- the `paymentHash`,
- the timing of every HTLC.

No protocol trick removes this observation while the topology is 1-hop.
Privacy work in v1.x optimizes for **other observers** — on-chain analysts,
Nostr relays, watchtowers, third parties that see only dispute postings —
and reduces **cross-channel / cross-hub linkability** for the same user.

## 1. Stealth `userA` per channel (`packages/sdk/src/stealth.ts`)

Each channel a user opens derives a fresh on-chain address from a
long-lived 32-byte **scan key**:

```
childPrivateKey = HMAC-SHA256(scanKey, label || 0x00 || nonce || counter)
```

The counter ranges over `0..255` and skips outputs outside `[1, n)` for
the secp256k1 order `n` (`MAX_RETRIES = 256`; cryptographically unreachable
to exhaust in practice).

Labels are domain-separated via the `StealthLabel` union:

| Label | Use |
|---|---|
| `STEALTH_LABEL_USER_A` | Sender's per-channel signing key |
| `STEALTH_LABEL_USER_B` | Recipient's per-invoice signing key |
| `STEALTH_LABEL_WATCHTOWER` | Reserved: watchtower's monitor key (no spend authority) |

The `StealthKeyManager.signerFor(label, nonce)` factory returns a fully
populated `LocalSigner` whose address is independent of every other
channel under the same scan key. An on-chain observer cannot cluster two
channels to the same user without the scan key.

The hub still sees its counterparty per channel. Stealth addresses break
chain-graph analysis, not hub-level analysis.

## 2. Recipient `userB` rotation (no SDK change)

The existing `createInvoice(args, signer)` API already accepts any
`Signer`. A recipient who wants per-invoice unlinkability passes an
ephemeral signer derived from `StealthKeyManager`:

```ts
const mgr = new StealthKeyManager(scanKey);
const ephemeral = mgr.signerFor(STEALTH_LABEL_USER_B, invoiceNonce);
const invoice = await createInvoice({ amount, chainId, expiryMs }, ephemeral);
// invoice.recipient is the stealth address, not the user's stable identity.
```

Two invoices with different nonces produce different `recipient`
addresses. The `paymentHash` is independent of the recipient (it derives
from a fresh preimage per invoice). See `packages/sdk/src/recipient-rotation.test.ts`.

**Caveats** the test comments call out:

- `amount` equality between invoices is unmodified — clustering by
  amount remains possible. Pair with §4 (fee bucketing) to mitigate.
- `expiryMs` equality is unmodified — clients who set identical expiries
  on every invoice leak via that field. Jitter or quantize on the
  caller's side.

## 3. Ephemeral Nostr pubkeys per payment (`packages/sdk/src/nostr-keys.ts`)

Reserved Nostr event kinds (`protocol-spec.md` §6.3):

| Kind | Name |
|---|---|
| 30401 | PaymentQuote |
| 30402 | PaymentInvoice |
| 30403 | PaymentReceipt |

In the naïve pattern a DVM signs all three with the same pubkey, so any
relay can trivially link the payment quote/invoice/receipt triple to one
DVM. The privacy posture instead derives **three distinct secp256k1
private keys per payment session**:

```ts
const mgr = new NostrEventKeyManager(scanKey);
const session = mgr.paymentSession(sessionNonce);
// session.quoteSecretKey, session.invoiceSecretKey, session.receiptSecretKey
// — each used to sign the corresponding Nostr event, never published.
```

The field names use `SecretKey` (not `Key`) so callers cannot confuse them
with the pubkeys that go on relays. Two payment sessions produce six
distinct secret keys; the relay sees three uncorrelated pubkeys per
session.

**Status**: helper only. No Nostr publisher exists in the repo yet
(event kinds 30401–30408 are reserved constants in
`packages/protocol/src/events.ts`); the publisher will consume this helper
when it lands.

## 4. Fee bucketing in `FlatPlusBpsFeePolicy` (`apps/hub/src/fee-policy.ts`)

The hub policy gains an optional `bucket` constructor argument:

```ts
new FlatPlusBpsFeePolicy(bps, flat, bucket);
```

When `bucket > 0`, `quoteBucketed(amount)` rounds the sender's outer-HTLC
amount up to the next multiple of `bucket`. The extra value accrues to
the fee (i.e., the hub keeps the padding):

```
baseFee        = floor(amount * bps / 10_000) + flat
senderHtlc     = ceil((amount + baseFee) / bucket) * bucket
paddingToBucket = senderHtlc - (amount + baseFee)
fee            = baseFee + paddingToBucket   // delivered amount unchanged
```

Two adjacent payments collapse into the same outer-HTLC value, so a
passive on-chain observer (or watchtower) cannot distinguish them from
the outer commitment alone. `bucket = 0` (default) leaves v1 behavior
untouched.

**Status**: helper only. The router (`apps/hub/src/router.ts`) still
calls `quote()`; integration into the route path is a follow-up.

## 5. Point Time-Locked Contracts (PTLCs) — `packages/state-machine/src/ptlc.ts`

v1 HTLCs commit to `paymentHash = sha256(preimage)`, **identical on both
legs** of a routed payment (§4.1). When on-chain HTLC settlement lands
in v2 (the headline `§5.4 → v2` milestone), the two reveals would become
a passive correlation oracle.

A PTLC fixes this by using a secp256k1 *point* commitment `T = s·G` and
a per-hop tweak `t`:

| | Inner leg (hub → recipient) | Outer leg (sender → hub) |
|---|---|---|
| Commitment | `T = r·G` | `T' = T + t·G = (r + t)·G` |
| Reveal | `r` (recipient) | `r + t` (hub composes) |

A third party who sees only `T'` cannot recover `T` without knowing `t`.
The hub sees both legs by topology — same caveat as §0.

The package ships:

- `PtlcGroup<P, S>` — abstract group interface (commit, point-add,
  scalar-add, point-eq);
- `ptlcVerify`, `ptlcOuterPoint`, `ptlcOuterScalar` — generic helpers;
- a toy `Z_p` group in tests (`packages/state-machine/src/ptlc.test.ts`)
  exercising the algebraic shape.

**Status**: helper + algebraic test. Production v2 swaps the toy group
for `@noble/curves/secp256k1`; constant-time `pointEq` is the wrapper's
responsibility.

## Cross-references

- `packages/sdk/src/stealth.ts` — stealth key derivation, `StealthKeyManager`.
- `packages/sdk/src/nostr-keys.ts` — Nostr event-key derivation,
  `NostrEventKeyManager`.
- `packages/sdk/src/recipient-rotation.test.ts` — usage pattern + leak caveats.
- `apps/hub/src/fee-policy.ts` — `FlatPlusBpsFeePolicy` with bucketing.
- `packages/state-machine/src/ptlc.ts` — PTLC algebra (stub group).
- `docs/threat-model.md` — adversary model, including the "Privacy" note.
