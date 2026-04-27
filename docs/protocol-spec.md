# tainnel protocol specification (v0)

> Status: bootstrap placeholder. Section bodies will be filled in module-by-module
> alongside the implementation. Section headings are stable and may be referenced from
> code comments.

## 1. Channel lifecycle

States: `pending`, `open`, `closing-cooperative`, `closing-unilateral`, `disputed`,
`closed`. Allowed transitions and on-chain triggers will be enumerated here.

## 2. State updates

Encoding, version monotonicity, dual signature requirement, and the canonical
`htlcsRoot` aggregation will be specified here.

## 3. HTLC

Direction model (AtoB / BtoA), hash function (sha256 by default), preimage size,
expiry windows, and settle/fail semantics will be specified here.

## 4. Routing

How a hub routes from `client → hub → recipient` in a 1-hop topology, including the
fee policy interface, in-flight HTLC accounting, and refusal conditions.

## 5. Dispute resolution

Submission flow for `closeUnilateral`, the dispute window, valid challenges, finalization
math, and how watchtower penalty proofs are weighted against client-submitted proofs.

## 6. Wire format

EIP-712 typed-data definitions, transport message kinds, Nostr event-kind allocations
(currently 30401–30420), and the JSON envelopes used over the hub WebSocket.

## 7. Security considerations

State backup obligations, watchtower availability assumptions, fee griefing, dust
handling, eclipse attacks at the relay layer, and the expected behavior under chain
reorgs.
