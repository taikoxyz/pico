---
'@inferenceroom/pico-protocol': patch
'@inferenceroom/pico-sdk': patch
---

Round-4 follow-up — make per-counterparty HTLC cap per-token.

**state-machine + hub (HIGH)**: `MAX_HTLC_VALUE_PER_COUNTERPARTY = 1e8`
is the USDC default (100 USDC at 6 decimals). For an 18-decimal channel
token (native ETH, PTST) the same scalar clamps payment to 1e-10 of the
token, so even a 0.00001 ETH payment (1e13 wei) was rejected by the
router with `per-counterparty inflight would exceed 100000000`.

`HtlcAdmissionContext` now accepts an optional `maxPerCounterpartyValue`
in the channel-token's base units; the hub router fills it in
per-token (1 ETH / 100 PTST / 100 USDC), and `checkHtlcAdmissible`
falls back to the legacy scalar when the field is omitted so existing
unit tests stay green.

Like the `topup-policy` PTST entry, the test-token override should be
promoted to operator-configurable env vars before more allowlisted
ERC-20s ship to production.
