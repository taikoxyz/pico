---
"@inferenceroom/pico-landing": patch
---

Surface native ETH alongside USDC in the Assets section: the v2 PaymentChannel
contracts on Taiko mainnet allowlist both, and the page now reflects that.
Section 02 is renamed (`#usdc` → `#assets`) and shows USDC and the native ETH
sentinel (`0x0000...0000`) as separate cards with their respective decimals and
per-token minimum channel amounts.
