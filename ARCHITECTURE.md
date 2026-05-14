# Architecture

This document covers the high-level shape of pico: the actors, what each package
does, where trust boundaries sit, and why the topology is **1-hop**.

## Components

```mermaid
flowchart LR
    subgraph User["User device"]
        CLI[pico CLI]
        SDK[@inferenceroom/pico-sdk]
        SM[@inferenceroom/pico-state-machine]
    end

    subgraph HubInfra["Hub operator"]
        Hub[@inferenceroom/pico-hub]
        WT[@inferenceroom/pico-watchtower]
    end

    subgraph Chain["Taiko L2"]
        PC[PaymentChannel.sol]
        ADJ[Adjudicator.sol]
    end

    subgraph Nostr["Nostr relays"]
        REL[(Relays)]
    end

    CLI --> SDK --> SM
    SDK <-->|WebSocket| Hub
    Hub <-->|DVM events| REL
    Hub -->|open/close/dispute| PC
    PC -->|verify| ADJ
    WT -->|watch| PC
    WT -->|penalty tx| PC
```

## Trust assumptions

| Actor       | Trust level      | Why                                                                 |
|-------------|------------------|---------------------------------------------------------------------|
| User signer | trusted to self  | Holds the user's signing key via CLI or programmatic SDK.           |
| Hub         | semi-trusted     | Cannot steal funds; can refuse service or stall a payment.          |
| Watchtower  | semi-trusted     | Cannot steal funds; can fail to post a penalty tx in time.          |
| Adjudicator | trustless        | Pure on-chain logic; verifies EIP-712 signed states.                |
| Nostr relay | untrusted        | Used only as transport for DVM discovery, never for state authority. |

## Data flow: pay client → hub → recipient (happy path)

1. Client signs an HTLC update locking funds in `client-hub` channel.
2. Hub forwards an HTLC offer in the `hub-recipient` channel.
3. Recipient settles by revealing preimage; hub settles upstream.
4. Both channels advance one version. Nothing on-chain.

## Data flow: hub provisions inbound liquidity (§8 topUp)

For step 2 above to succeed, the `hub-recipient` channel must already have
hub-side outbound liquidity. v1.1's `topUp` flow handles this:

1. Recipient opens a single-sided channel with `amountB == 0`.
2. Hub's chain-watcher observes `ChannelOpened`, evaluates its admission
   policy (per-counterparty cap, hot-wallet headroom), and pushes
   `proposeTopUp` over WebSocket.
3. Recipient's SDK validates the offer (per spec §8.6) and replies
   `acceptTopUp` with their signature.
4. Hub submits `topUp(channelId, amount, prev, next)` on-chain. Both parties
   observe `ToppedUp`.
5. When a topped-up channel closes (`ChannelClosedCooperative` /
   `ChannelFinalized`), the hub's auto-recycle hook reuses the recovered
   liquidity (in the channel's token — USDC by default, also ETH or any
   other owner-allowlisted ERC-20) for the next queued offer.

The SDK exposes `client.closeUnilateralFromOpen(channelId)` for the
anti-hostage path: a user whose hub refuses to co-sign any state can recover
their on-chain deposit via the contract's dedicated entry point.

## Data flow: dispute

1. Counterparty publishes an old, but signed, state on-chain (`closeUnilateral`).
   The state MAY carry a non-empty `htlcsRoot` in v2 (v1 rejected this).
2. The dispute window starts (24h).
3. The defending party (or their watchtower) calls `dispute` with a strictly newer
   signed state. The Adjudicator verifies signatures, version monotonicity, and
   the v2 conservation invariant
   `balanceA + balanceB + htlcsTotalLocked == amountA + amountB`.
4. After the window expires, the first `finalize` call:
   - takes the fast path if the posted state had `htlcsCount == 0` (byte-equivalent
     to v1 finalize), or
   - transitions to `Status.ResolvingHtlcs` if `htlcsCount > 0`, setting
     `htlcResolutionDeadline = block.timestamp + MAX_HTLC_DURATION + HTLC_RESOLUTION_GRACE`
     (~4h ceiling, safe under the off-chain HTLC duration cap).
5. While in `Status.ResolvingHtlcs`, anyone may call
   `claimHtlc(channelId, htlc, proof, sortedIndex, totalLeaves, preimage)` (when
   `block.timestamp <= htlc.expiry`) or `refundHtlc(...)` (when `block.timestamp >
   htlc.expiry`). Both verify an ordered Merkle proof against the posted
   `htlcsRoot` and credit `pendingPayout` on the appropriate side. The
   penalty path short-circuits this phase — if `penalized == true`, the entire
   pot (including locked HTLC value) goes to the non-closer.
6. A second `finalize` call (once every HTLC has been claimed or refunded, or
   after `htlcResolutionDeadline` for force-refund) distributes
   `postedBalance{A,B} + pendingPayout{A,B}` and closes the channel.

> Watchtowers MUST persist the full HTLC set associated with each signed
> state (not just the root) so they can construct Merkle proofs during
> `Status.ResolvingHtlcs`. The hub forwards seen preimages over its existing
> HTTP surface (`POST /v1/preimage`). See `docs/release-notes-v2.md`.

## Why 1-hop

- **Routing is trivial.** A hub knows its own channels; no onion routing, no global
  graph gossip, no liquidity-rebalancing protocol.
- **Liquidity inversion fits the LSP model.** Hubs are paid to provide inbound
  liquidity to clients — exactly the Lightning LSP playbook, in a market that already
  has product/market fit.
- **Latency is bounded by one round-trip.** Critical for AI agent loops and DVM
  micro-payments.
- **Failure modes shrink.** A stalled hub at most stalls the user's outgoing channel;
  there's no whole-graph stuckness like multi-hop.

The cost: client liquidity is anchored to a hub. Mitigated by allowing a wallet to open
channels with multiple hubs and choose at pay-time.

## Module boundaries

- `protocol` is the **single source of truth** for types, EIP-712 schemas, and event
  kinds. Every other package imports from it; no other package re-exports protocol
  types.
- `state-machine` is a pure-function library. It must remain **I/O-free** so it can be
  reused by hubs, watchtowers, SDKs, and even the Adjudicator's reference logic.
- `sdk` is the only place that owns chain interaction (via viem) on the client side.
- `hub` and `watchtower` may interact with the chain directly; both must reuse
  `state-machine` for state validation rather than reimplementing rules.
