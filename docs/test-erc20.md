# Smoke-test ERC-20 (PicoTest / PTST) on Taiko mainnet

A standalone, open-mint ERC-20 deployed alongside the v2 redeploy to let us
exercise the full channel lifecycle on Taiko mainnet without burning real
USDC.

**Status: TEST ONLY. Remove from the allowlist after smoke testing concludes.**

## Deployment

| Field | Value |
|---|---|
| Network | Taiko mainnet (chain ID 167000) |
| Contract | `0x3CF2321323C23c9F91daFe99E2b121cab5cE3759` |
| Name | `PicoTest` |
| Symbol | `PTST` |
| Decimals | 18 |
| Source | `packages/contracts/src/TestToken.sol` |
| Deploy script | `packages/contracts/script/DeployTestToken.s.sol` |

## Initial supply

| Holder | Address | Amount |
|---|---|---|
| Owner / deployer EOA | `0x327fa3369B1D1D42120d84bc407e5865ECa7c458` | 1,000,000 PTST |
| Hub operator | `0x2d8Bac9eC662F7F09E59296f43B59D21EF6E9cc9` | 1,000,000 PTST |

`mint(address,uint256)` is open — anyone can mint more. The intent is explicitly
*not* production-grade; it exists to make smoke testing cheap and repeatable.

## PaymentChannel allowlist entry

PTST is allowlisted on the live PaymentChannel proxy
`0xA2665f2Fdf23CAA362b63F7A8902466f0504332d`, with `minChannelAmount = 1 PTST`
(`1e18`).

## Removing after smoke tests

```
RPC=https://rpc.mainnet.taiko.xyz
PC=0xA2665f2Fdf23CAA362b63F7A8902466f0504332d
TEST=0x3CF2321323C23c9F91daFe99E2b121cab5cE3759

cast send $PC "setTokenAllowed(address,bool)" $TEST false \
  --rpc-url $RPC --private-key $OWNER_PRIVATE_KEY
```

Once de-allowlisted, no new channels can be opened against PTST, but any
already-open PTST channel will still cooperatively close. After all PTST
channels are closed, the test deployment is fully retired.

The TestToken contract itself remains on-chain (immutable); only the allowlist
entry is cleared.
