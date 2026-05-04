# @pico/protocol

Shared protocol primitives for the **pico** 1-hop payment channel network: TypeScript
types, EIP-712 typed-data definitions, on-chain constants, and Nostr event-kind
allocations. This package contains **no runtime logic** — it is a single source of truth
that every other package (state machine, SDK, hub, watchtower) imports from.

It is browser-safe: zero Node-only dependencies.
