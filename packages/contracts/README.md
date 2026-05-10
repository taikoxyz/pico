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

> **v1.1 redeployment pending.** The addresses below host the pre-§8
> implementation: no `topUp`, no `closeUnilateralFromOpen`, and the old
> `CooperativeClose` typed-data without `version` / `validUntil`. v1.1
> contracts in `src/` will be deployed to fresh proxies; this table will be
> updated alongside that release. Until then,
> `CONTRACT_ADDRESSES[TAIKO_MAINNET_CHAIN_ID]` in `@inferenceroom/pico-protocol`
> still points at the pre-§8 proxies.

| Artifact | Address |
|---|---|
| **Adjudicator proxy** | [`0xee660F9c471d833f092Bc79f5c8F9943469b0e05`](https://taikoscan.io/address/0xee660F9c471d833f092Bc79f5c8F9943469b0e05) |
| **PaymentChannel proxy** | [`0xCDEF7911155c8db64Ef810Ae8C538024550594D7`](https://taikoscan.io/address/0xCDEF7911155c8db64Ef810Ae8C538024550594D7) |
| Adjudicator implementation | [`0x227AF78680f8E225A285E220C8165FD6e9312f08`](https://taikoscan.io/address/0x227AF78680f8E225A285E220C8165FD6e9312f08) |
| PaymentChannel implementation | [`0x51e44d4dcfccB37ac1C80941713e1417c21E9df1`](https://taikoscan.io/address/0x51e44d4dcfccB37ac1C80941713e1417c21E9df1) |
| USDC (allowlisted, Circle native) | [`0x07d83526730c7438048D55A4fc0b850e2aaB6f0b`](https://taikoscan.io/address/0x07d83526730c7438048D55A4fc0b850e2aaB6f0b) |

All four contracts have verified source on Taikoscan via the Etherscan V2
unified API (the proxies share the `ERC1967Proxy` source). Owner of both
proxies: [`0x4757D97449acA795510b9f3152C6a9019A3545c3`](https://taikoscan.io/address/0x4757D97449acA795510b9f3152C6a9019A3545c3).

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
export PAYMENT_CHANNEL_PROXY=0xCDEF7911155c8db64Ef810Ae8C538024550594D7
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
