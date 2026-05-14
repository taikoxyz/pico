---
'@inferenceroom/pico-protocol': patch
'@inferenceroom/pico-sdk': patch
---

Round-4 follow-up — hub seeds per-channel liquidity snapshots on startup.

**hub (HIGH)**: `LiquidityTracker.hydrate(...)` only restores in-flight
HTLC reservations. The per-channel outbound/inbound *snapshots* are only
ever seeded by `ws.registerChannel`, which itself runs only inside the
chain-watcher bootstrap path — and that path is gated on
`channelPool.get(id) === undefined`. After any hub restart every channel
is already in the pool, so the snapshot stays empty and the router
returns `channel cannot reserve N; available outbound 0` for every pay,
including channels that just had a successful on-chain top-up. Server
startup now walks `channelPool.list()` and seeds `liquidity.set(id,
{outbound, inbound})` from the latest co-signed state per channel.

(Bump applies to deploy-relevant packages only; the source change is
entirely in `apps/hub/src/server.ts` but the release pipeline only
cuts a Docker tag on a sdk/protocol/state-machine bump.)
