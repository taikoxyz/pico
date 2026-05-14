---
'@inferenceroom/pico-protocol': patch
'@inferenceroom/pico-sdk': patch
---

Round-4 follow-up — pass the channel's actual token to `chain.topUp`.

**hub (HIGH)**: when the user accepts a `proposeTopUp`, `TopUpHandler`
was passing `this.deps.token` to `chain.topUp(...)`. That field is set
at server startup from "the first registered channel's token" — for a
mixed-token hub (e.g. a USDC channel registered before any ETH
channel) every native-ETH topUp got submitted as an ERC-20 transfer
and the contract reverted with `ETH value!=amount` because the chain
adapter only sets `value: amount` when the token argument is
`address(0)`. Pass `channel.token` from the per-offer channel record
instead.
