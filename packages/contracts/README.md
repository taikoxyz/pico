# @tainnel/contracts

Solidity 0.8.26 contracts for tainnel pairwise payment channels. Built with Foundry.

Surface area:

- `PaymentChannel.sol` — pairwise channel core (open / update / cooperative-close /
  unilateral-close / dispute).
- `HTLC.sol` — hash-time-locked-contract primitives, packaged as a library.
- `Adjudicator.sol` — verifies signed states for dispute resolution.
- `interfaces/` — public ABI surface for SDKs and watchtowers.

This package ships **interface stubs and NatSpec** in the bootstrap. Function bodies
revert with `"not implemented"` until the protocol layer lands.

## Usage

```bash
pnpm --filter @tainnel/contracts build      # forge build
pnpm --filter @tainnel/contracts test       # forge test
forge install                               # one-time, fetches forge-std + OpenZeppelin
```

Configure RPCs via `TAIKO_MAINNET_RPC_URL` / `TAIKO_HOODI_RPC_URL` in your environment.
