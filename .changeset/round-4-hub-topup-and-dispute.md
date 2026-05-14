---
'@inferenceroom/pico-protocol': patch
'@inferenceroom/pico-sdk': patch
---

Round-4 mainnet smoke findings (issue #100 follow-up) — fixes two production
blockers in v2.1.2.

**hub (HIGH)**: §8 inbound-liquidity policy lowered `defaultOfferAmount` for
native ETH from `0.05 ETH` → `0.0001 ETH`. With a hub hot-wallet of `0.05
ETH`, the prior default exhausted headroom after a single channel and every
subsequent open returned `topup: queuing — admission policy rejected`. The
new default lets `0.05 ETH` service ~500 channels; the per-channel and
per-counterparty caps (`0.1 ETH` / `1 ETH`) are unchanged, so the hub can
still grow inbound to a given user via repeat top-ups.

**hub (HIGH)**: dispute-handler now skips submitting any state whose
`sigA`/`sigB` is a sentinel (`r=s=0`). The chain-watcher bootstrap (PR
#102) seeds a v0 sentinel-signed state into the channel pool so the router
has something to apply HTLC updates onto; if that channel is later seen to
close unilaterally on-chain, the hub previously busy-looped
`dispute(...)` calls that reverted with `bad sig`, polluting logs and
wasting RPC every poll for ~24 h until the dispute deadline elapsed.
