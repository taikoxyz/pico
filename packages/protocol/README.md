# @inferenceroom/pico-protocol

Shared protocol primitives for the **pico** 1-hop payment channel network: TypeScript
types, EIP-712 typed-data definitions, on-chain constants, and Nostr event-kind
allocations. This package contains **no runtime logic** — it is a single source of truth
that every other package (state machine, SDK, hub, watchtower) imports from.

Mirrors `docs/protocol-spec.md` §0–§8 (v1.1):

- `types.ts` / `eip712.ts` — `ChannelState`, `Update`, `CooperativeClose` (with
  `version` + `validUntil` replay-defense fields per §1, §6.2), `Htlc`,
  `Invoice`.
- `constants.ts` — §4.3 routing caps (`MAX_HTLCS_PER_CHANNEL`,
  `MAX_HTLC_VALUE_PER_COUNTERPARTY`, `MIN/MAX_HTLC_DURATION_MS`,
  `HTLC_TIMEOUT_DELTA_MS`); `EMPTY_SIG_BYTES` / `ZERO_SIG_HEX` for the §8
  topUp sentinel branch.
- `topup-messages.ts` — §8.6 `proposeTopUp` / `acceptTopUp` / `rejectTopUp` /
  `topUpComplete` envelopes.

It is browser-safe: zero Node-only dependencies.
