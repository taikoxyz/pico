# Architecture

This document covers the high-level shape of tainnel: the actors, what each package
does, where trust boundaries sit, and why the topology is **1-hop**.

## Components

```mermaid
flowchart LR
    subgraph Agent["Agent / operator host"]
        CLI[@tainnel/cli]
        SDK[@tainnel/sdk]
        SM[@tainnel/state-machine]
    end

    subgraph HubInfra["Hub operator"]
        Hub[@tainnel/hub]
        WT[@tainnel/watchtower]
    end

    subgraph Chain["Taiko L2"]
        PC[PaymentChannel.sol]
        ADJ[Adjudicator.sol]
    end

    subgraph Nostr["Nostr relays (Phase 2 — DVM payments)"]
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
| Agent wallet | trusted to self  | Holds the agent / operator's signing key. v1: hot key in env var. |
| Hub         | semi-trusted     | Cannot steal funds; can refuse service or stall a payment.          |
| Watchtower  | semi-trusted     | Cannot steal funds; can fail to post a penalty tx in time.          |
| Adjudicator | trustless        | Pure on-chain logic; verifies EIP-712 signed states.                |
| Nostr relay | untrusted        | Used only as transport for DVM discovery, never for state authority. |

## Data flow: pay client → hub → recipient (happy path)

1. Client signs an HTLC update locking funds in `client-hub` channel.
2. Hub forwards an HTLC offer in the `hub-recipient` channel.
3. Recipient settles by revealing preimage; hub settles upstream.
4. Both channels advance one version. Nothing on-chain.

## Data flow: dispute

1. Counterparty publishes an old, but signed, state on-chain (`closeUnilateral`).
2. The dispute window starts.
3. The defending party (or their watchtower) calls `dispute` with a strictly newer
   signed state. The Adjudicator verifies signatures and version monotonicity.
4. After the window expires, `finalize` distributes funds based on the latest accepted
   state.

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
