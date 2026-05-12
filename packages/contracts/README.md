# @inferenceroom/pico-contracts

Solidity 0.8.26 contracts for pico pairwise payment channels. Built with Foundry.

Surface area:

- `PaymentChannel.sol` — pairwise channel core (open / cooperative-close /
  unilateral-close / `closeUnilateralFromOpen` / `topUp` / dispute / penalty /
  finalize). UUPS upgradeable behind `ERC1967Proxy`. Implements the v1.1 §8
  inbound-liquidity surface plus the §1 / §6.2 cooperative-close replay
  defenses (`version` + `validUntil`).
- `Adjudicator.sol` — EIP-712 typed-data verifier for `ChannelState`, `Htlc`,
  `Update`, and `CooperativeClose` (the latter now carrying `version` +
  `validUntil`). UUPS upgradeable.
- `HTLC.sol` — hash-time-locked-contract primitives (`hashLock`,
  `verifyPreimage`, `rootOf`), packaged as a stateless library.
- `interfaces/` — public ABI surface for SDKs and watchtowers (`IPaymentChannel`,
  `IWatchtower`).

## Build & test

```bash
pnpm --filter @inferenceroom/pico-contracts build      # forge build
pnpm --filter @inferenceroom/pico-contracts test       # forge test (104 tests)
forge install                               # one-time, fetches forge-std + OZ
```

`foundry.toml` pins `evm_version = "shanghai"`. **Do not remove the pin** — solc
0.8.26 + Foundry default to Cancun, which emits `MCOPY` opcodes that trap as
`INVALID` on Taiko mainnet (Shanghai EVM) and consume the entire gas limit.

Configure RPCs via `TAIKO_MAINNET_RPC_URL` / `TAIKO_HOODI_RPC_URL` in your
environment.

## Deployments

### Taiko mainnet (chainId 167000)

| Artifact | Address |
|---|---|
| **Adjudicator proxy** | [`0x8C913a936F99e93e298f7800f14C46C32D71e26B`](https://taikoscan.io/address/0x8C913a936F99e93e298f7800f14C46C32D71e26B) |
| **PaymentChannel proxy** | [`0xA2665f2Fdf23CAA362b63F7A8902466f0504332d`](https://taikoscan.io/address/0xA2665f2Fdf23CAA362b63F7A8902466f0504332d) |
| Adjudicator implementation | [`0x12D099A14B91d7298bc1aCdC6FE7776738ba32b9`](https://taikoscan.io/address/0x12D099A14B91d7298bc1aCdC6FE7776738ba32b9) |
| PaymentChannel implementation | [`0x67513Be4ee3792Ffee4CbC1396853404d07e855E`](https://taikoscan.io/address/0x67513Be4ee3792Ffee4CbC1396853404d07e855E) |
| USDC (allowlisted, Circle native) | [`0x07d83526730c7438048D55A4fc0b850e2aaB6f0b`](https://taikoscan.io/address/0x07d83526730c7438048D55A4fc0b850e2aaB6f0b) |

All four contracts have verified source on Taikoscan via the Etherscan V2
unified API (the proxies share the `ERC1967Proxy` source). Owner of both
proxies: [`0x327fa3369B1D1D42120d84bc407e5865ECa7c458`](https://taikoscan.io/address/0x327fa3369B1D1D42120d84bc407e5865ECa7c458).

Configured constants: `DISPUTE_WINDOW = 86400s` (24h),
`MIN_CHANNEL_AMOUNT = 10 USDC`. The proxies use 1-step `OwnableUpgradeable`;
only the `owner` may authorize a UUPS upgrade.

Canonical deploy addresses are also exported from
[`@inferenceroom/pico-protocol`](../protocol/src/constants.ts) under
`CONTRACT_ADDRESSES[TAIKO_MAINNET_CHAIN_ID]` and `USDC_TOKENS[TAIKO_MAINNET_CHAIN_ID]`.

## Upgrade an existing proxy in place

`script/UpgradePaymentChannel.s.sol` deploys a new `PaymentChannel`
implementation and calls `upgradeToAndCall` on the existing proxy. The
broadcast must be sent from the proxy owner.

```bash
cd packages/contracts
export DEPLOYER_PRIVATE_KEY=0x...                     # current proxy owner
export PAYMENT_CHANNEL_PROXY=0xA2665f2Fdf23CAA362b63F7A8902466f0504332d
export TAIKO_MAINNET_RPC_URL=https://rpc.mainnet.taiko.xyz

# Dry-run
forge script script/UpgradePaymentChannel.s.sol --rpc-url taiko_mainnet

# Broadcast
forge script script/UpgradePaymentChannel.s.sol --rpc-url taiko_mainnet \
    --broadcast --gas-estimate-multiplier 200
```

## Deploy a fresh stack

`script/Deploy.s.sol` deploys impls + ERC1967 proxies + allowlists USDC in one
go. `script/DeployProxies.s.sol` is a remediation helper that reuses
already-deployed impls.

```bash
cd packages/contracts
export DEPLOYER_PRIVATE_KEY=0x...
export USDC_ADDRESS=0x07d83526730c7438048D55A4fc0b850e2aaB6f0b
export TAIKO_MAINNET_RPC_URL=https://rpc.mainnet.taiko.xyz

# Dry-run
forge script script/Deploy.s.sol --rpc-url taiko_mainnet

# Broadcast (200% gas multiplier as a defensive cushion)
forge script script/Deploy.s.sol --rpc-url taiko_mainnet \
    --broadcast --gas-estimate-multiplier 200
```

Verify on Taikoscan (after deploy) using the unified Etherscan V2 API:

```bash
forge verify-contract <addr> <path>:<name> --watch \
    --verifier etherscan \
    --verifier-url "https://api.etherscan.io/v2/api?chainid=167000" \
    --etherscan-api-key "$TAIKOSCAN_API_KEY"
```

For the proxies, append
`--constructor-args $(cast abi-encode "constructor(address,bytes)" <impl> <initData>)`
where `<initData>` is `cast calldata "initialize(...)" ...`.
