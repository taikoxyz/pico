---
'@inferenceroom/pico-protocol': patch
'@inferenceroom/pico-sdk': patch
---

Round-4 round-out — actually add the PTST per-token policy override.

The PTST entry was claimed in PR #115's changeset but the `topup-policy.ts`
hunk got dropped on the way through a stash/rebase. With the override
missing, an 18-decimal PTST channel hit the USDC-shaped 5_000_000n
default and the hub's on-chain topUp confirmed for `5e-12 PTST` — too
small to route any real payment.

This commit adds `perTokenDefaultOfferAmount[PTST] = 2 PTST` plus
matching per-channel (10 PTST) and per-counterparty (100 PTST) caps,
exactly as the v2.1.7 changeset described.
