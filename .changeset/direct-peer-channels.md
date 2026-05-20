---
"@inferenceroom/pico-sdk": minor
"@inferenceroom/pico-cli": minor
---

Add direct (hub-less) peer channels. Two users can now open a payment channel directly with each other, using a hub purely as an untrusted message relay (not a channel party, no liquidity, no fee, no co-signing).

- SDK: new `RelayTransport` and `ChannelClient({ peerMode: true })`. In peer mode the client co-signs inbound peer messages (open handshake, `payDirect`, single-channel HTLC, cooperative close) — the role the hub plays in the routed topology. Adds `channelAnnounce`/`channelAnnounceAck` and a `relay` wire message, plus an optional `ChainAdapter.getChannel` read used to verify an announced channel on-chain.
- CLI: `--peer` on `pico channel open`, `pico pay`, `pico channel close`, and `pico listen`; `pico hub status` now surfaces relay info.

Relay forwarding on the hub is opt-in via `HUB_ENABLE_RELAY` and observable at `GET /v1/info`, `GET /v1/stats`, and the operator-gated `GET /v1/relay/sessions`.
