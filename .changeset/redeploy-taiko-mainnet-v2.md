---
"@inferenceroom/pico-protocol": patch
---

Redeploy v2 contracts on Taiko mainnet. The previous proxies (v1.0) used the
old EIP-712 typehash `("pico","1")` and lacked HTLC settlement / native ETH /
`topUp` / `closeUnilateralFromOpen`. Fresh proxies, allowlisting USDC + native
ETH, replace them. The hub and watchtower funded addresses are preserved.

New Taiko mainnet addresses:

- PaymentChannel: `0xA2665f2Fdf23CAA362b63F7A8902466f0504332d`
- Adjudicator:    `0x8C913a936F99e93e298f7800f14C46C32D71e26B`
