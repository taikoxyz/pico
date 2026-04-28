# @tainnel/contracts

Solidity 0.8.26 contracts for tainnel pairwise payment channels. Built with Foundry.

Surface area:

- `PaymentChannel.sol` — pairwise channel core (open / cooperative-close /
  unilateral-close / dispute / penalty / finalize). UUPS upgradeable behind
  `ERC1967Proxy`.
- `Adjudicator.sol` — EIP-712 typed-data verifier for `ChannelState`, `Htlc`,
  `Update`, and `CooperativeClose`. UUPS upgradeable.
- `HTLC.sol` — hash-time-locked-contract primitives (`hashLock`,
  `verifyPreimage`, `rootOf`), packaged as a stateless library.
- `interfaces/` — public ABI surface for SDKs and watchtowers (`IPaymentChannel`,
  `IWatchtower`).

## Build & test

```bash
pnpm --filter @tainnel/contracts build      # forge build
pnpm --filter @tainnel/contracts test       # forge test (104 tests)
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
| **Adjudicator proxy** | [`0x775904054b4A97b3925f1Dd60aE61fBc81567dB9`](https://taikoscan.io/address/0x775904054b4A97b3925f1Dd60aE61fBc81567dB9) |
| **PaymentChannel proxy** | [`0x07B32f52523Fdf0780821595422DccEF31FA2335`](https://taikoscan.io/address/0x07B32f52523Fdf0780821595422DccEF31FA2335) |
| Adjudicator implementation | [`0x3abe77c8fEd229e1A150b3a81758Af191D3272Af`](https://taikoscan.io/address/0x3abe77c8fEd229e1A150b3a81758Af191D3272Af) |
| PaymentChannel implementation (current) | [`0xe798e1e6D0f2cF9b2dd4B53B2ad18b9D7654Ba14`](https://taikoscan.io/address/0xe798e1e6D0f2cF9b2dd4B53B2ad18b9D7654Ba14) |
| PaymentChannel implementation (v1, superseded) | [`0xd72793eE80fFb6E02Cb4C747FAb8C66601FD4347`](https://taikoscan.io/address/0xd72793eE80fFb6E02Cb4C747FAb8C66601FD4347) |
| USDC (allowlisted, Circle native) | [`0x07d83526730c7438048D55A4fc0b850e2aaB6f0b`](https://taikoscan.io/address/0x07d83526730c7438048D55A4fc0b850e2aaB6f0b) |

All five contracts have verified source on Taikoscan (the proxies share the
`ERC1967Proxy` source). The `PaymentChannel` proxy was upgraded from the v1
impl to the current impl to ship the `dispute()` signature-verification fix —
the v1 impl verified the non-closer's signature, which let the non-closer
redirect funds during a unilateral close. All proxy storage was preserved;
the Adjudicator and HTLC library were unchanged.

Configured constants: `DISPUTE_WINDOW = 86400s` (24h),
`MIN_CHANNEL_AMOUNT = 10 USDC`. The proxies use 1-step `OwnableUpgradeable`;
only the `owner` may authorize a UUPS upgrade.

Canonical deploy addresses are also exported from
[`@tainnel/protocol`](../protocol/src/constants.ts) under
`CONTRACT_ADDRESSES[TAIKO_MAINNET_CHAIN_ID]` and `USDC_TOKENS[TAIKO_MAINNET_CHAIN_ID]`.

## Upgrade an existing proxy in place

`script/UpgradePaymentChannel.s.sol` deploys a new `PaymentChannel`
implementation and calls `upgradeToAndCall` on the existing proxy. The
broadcast must be sent from the proxy owner.

```bash
cd packages/contracts
export DEPLOYER_PRIVATE_KEY=0x...                     # current proxy owner
export PAYMENT_CHANNEL_PROXY=0x07B32f52523Fdf0780821595422DccEF31FA2335
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
