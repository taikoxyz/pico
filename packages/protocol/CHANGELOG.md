# @inferenceroom/pico-protocol

## 2.1.0

## 2.0.3

### Patch Changes

- b9952b4: Redeploy v2 contracts on Taiko mainnet. The previous proxies (v1.0) used the
  old EIP-712 typehash `("pico","1")` and lacked HTLC settlement / native ETH /
  `topUp` / `closeUnilateralFromOpen`. Fresh proxies, allowlisting USDC + native
  ETH, replace them. The hub and watchtower funded addresses are preserved.

  New Taiko mainnet addresses:

  - PaymentChannel: `0xA2665f2Fdf23CAA362b63F7A8902466f0504332d`
  - Adjudicator: `0x8C913a936F99e93e298f7800f14C46C32D71e26B`

## 2.0.2

### Patch Changes

- 0927067: End-to-end test of the Changesets + GitHub Actions OIDC trusted-publishing pipeline. No code changes; verifies that the auto-generated "Version Packages" PR + npm provenance flow works for all five publishable packages.

## 2.0.1

### Major Changes

- 78d4fdd: release 1.0.1

### Patch Changes

- release 2.0.1

## 1.0.0

### Major Changes

- First release.
