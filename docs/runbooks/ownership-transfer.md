# Mainnet ownership transfer to multisig + timelock

Closes audit finding **PC-09**. After deployment via `script/Deploy.s.sol`, the
deployer EOA is the sole owner of both `Adjudicator` and `PaymentChannel` UUPS
proxies. The owner can upgrade implementations and toggle the
`PaymentChannel.allowedTokens` allowlist. This runbook hands that authority to a
Safe-multisig-controlled `TimelockController`.

## Why

| Attack surface today | After this handoff |
|---|---|
| 1 EOA can upgrade either proxy at any block | Safe quorum must propose; queued op waits `MIN_DELAY`; Safe quorum must execute |
| 1 EOA can allowlist arbitrary tokens | Same delay-and-quorum pattern |
| 1 EOA compromise = total protocol takeover | Compromise of N/M Safe signers + survival of `MIN_DELAY` window |

## Prerequisites

- Safe multisig deployed on Taiko mainnet. Recommended threshold: **3 of 5**
  signers minimum, with signers held on independent hardware wallets.
- `MIN_DELAY` decided. Recommended for mainnet: **48 hours** (172800 sec). The
  longer the delay, the more time users have to drain channels via cooperative
  close if a malicious upgrade is queued. The shorter, the more nimble routine
  ops are. 48h is the default tradeoff floor; do not go below 24h.
- Operator has run the **full sequence on Hoodi testnet end-to-end** with the
  same Safe topology (deploy timelock → transfer → schedule + execute upgrade →
  verify implementation slot). This is the single most important defence
  against fat-fingering `NEW_OWNER`.
- Submodules synced: `git submodule update --init --recursive`.
- Foundry toolchain present (`foundryup`).

## Step-by-step (mainnet)

### 1. Deploy the timelock

```bash
export DEPLOYER_PRIVATE_KEY=...        # cold key, used only for one-shot deploys
export SAFE_ADDRESS=0x...              # the multisig
export MIN_DELAY=172800                 # 48 hours

cd packages/contracts
forge script script/DeployTimelock.s.sol \
  --rpc-url taiko_mainnet \
  --broadcast --verify -vvv
```

Record the printed `TimelockController` address as `$TIMELOCK`.

### 2. Verify on Taikoscan

- Source code matches the OZ v5.6.1 `TimelockController.sol` referenced by
  `packages/contracts/lib/openzeppelin-contracts/contracts/governance/`.
- Constructor args match: `minDelay=$MIN_DELAY`, `proposers=[$SAFE_ADDRESS]`,
  `executors=[$SAFE_ADDRESS]`, `admin=address(0)`.

### 3. Sanity-check on-chain

```bash
cast call $TIMELOCK "getMinDelay()(uint256)" --rpc-url taiko_mainnet
cast call $TIMELOCK "hasRole(bytes32,address)(bool)" \
  $(cast keccak "PROPOSER_ROLE") $SAFE_ADDRESS \
  --rpc-url taiko_mainnet
cast call $TIMELOCK "hasRole(bytes32,address)(bool)" \
  $(cast keccak "EXECUTOR_ROLE") $SAFE_ADDRESS \
  --rpc-url taiko_mainnet
```

All three must return the expected values: delay = `$MIN_DELAY`, both roles =
`true`.

### 4. Transfer ownership

```bash
export ADJUDICATOR_PROXY=0x...          # from `Deploy.s.sol` output
export PAYMENT_CHANNEL_PROXY=0x...
export NEW_OWNER=$TIMELOCK

forge script script/TransferOwnership.s.sol \
  --rpc-url taiko_mainnet \
  --broadcast -vvv
```

The script asserts post-conditions: both `owner()` views must equal
`$TIMELOCK` after the broadcast. It also rejects EOAs (`NEW_OWNER.code.length
> 0`) before broadcasting.

### 5. Verify ownership on Taikoscan

```bash
cast call $ADJUDICATOR_PROXY "owner()(address)" --rpc-url taiko_mainnet
cast call $PAYMENT_CHANNEL_PROXY "owner()(address)" --rpc-url taiko_mainnet
```

Both must equal `$TIMELOCK`.

### 6. Burn the deployer key

`$DEPLOYER_PRIVATE_KEY` no longer holds any owner authority over the deployed
proxies. Move it to a sealed cold-storage location or destroy it. Document the
action in your incident log so future audits can confirm.

## 🔴 Recovery

`transferOwnership` is **single-step and irreversible** in OZ
contracts-upgradeable v4.9.6. If `NEW_OWNER` is wrong:

- If `NEW_OWNER` is an EOA you don't control or a contract that cannot call
  `transferOwnership` back, **funds are still safe** — the protocol state
  machine continues, channels can close cooperatively or unilaterally — but you
  have **lost upgrade authority forever**. Treat this as a P0 incident: drain
  channels via cooperative close, freeze new opens, prepare a coordinated
  migration to a fresh deployment.
- The `TransferOwnership.s.sol` script asserts `newOwner.code.length > 0`
  before broadcasting; this catches the most common mistake (handing to an
  EOA). The mandatory testnet dry-run is the real defence.

## Routine governed upgrade (post-handoff)

After ownership is held by the timelock, every owner-gated call must be
queued, wait `MIN_DELAY`, then executed. Both calls go through the Safe.

### Upgrade an implementation

1. Deploy the new implementation. Anyone can do this — the impl holds no
   storage. Record `$NEW_IMPL`.
   ```bash
   forge create src/PaymentChannel.sol:PaymentChannel \
     --rpc-url taiko_mainnet \
     --private-key $DEPLOY_KEY
   ```
2. In the Safe UI, propose:
   ```
   target:  $TIMELOCK
   value:   0
   data:    cast calldata "schedule(address,uint256,bytes,bytes32,bytes32,uint256)" \
            $PAYMENT_CHANNEL_PROXY 0 \
            $(cast calldata "upgradeTo(address)" $NEW_IMPL) \
            0x0000000000000000000000000000000000000000000000000000000000000000 \
            0x000000000000000000000000000000000000000000000000000000000000000N \
            $MIN_DELAY
   ```
   The `0x...0N` salt should be a unique nonce per operation. Sign + execute.
3. Wait `MIN_DELAY` seconds. Anyone can monitor:
   ```bash
   OP_ID=$(cast call $TIMELOCK "hashOperation(address,uint256,bytes,bytes32,bytes32)(bytes32)" \
     $PAYMENT_CHANNEL_PROXY 0 \
     $(cast calldata "upgradeTo(address)" $NEW_IMPL) \
     0x00...0 0x...0N)
   cast call $TIMELOCK "isOperationReady(bytes32)(bool)" $OP_ID
   ```
4. In the Safe UI, propose `Timelock.execute(...)` with the same args. Sign +
   execute.
5. Verify implementation slot post-upgrade:
   ```bash
   cast storage $PAYMENT_CHANNEL_PROXY \
     0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc \
     --rpc-url taiko_mainnet
   ```
   The lower 20 bytes must equal `$NEW_IMPL`.

### Toggle an allowlisted token

Same pattern with `data = cast calldata "setTokenAllowed(address,bool)"
$TOKEN true`.

## Test coverage

`packages/contracts/test/TransferOwnership.t.sol` exercises this entire flow
end-to-end against fresh proxies, asserting that:

- Deployer is locked out of upgrade and `setTokenAllowed` after transfer.
- Safe cannot bypass the timelock with direct calls.
- Scheduled operations cannot execute before `MIN_DELAY` elapses.
- After the delay, the Safe can execute upgrades and `setTokenAllowed`
  through the timelock.
- Non-proposer / non-executor addresses are rejected.

Run before any mainnet broadcast:

```bash
cd packages/contracts
forge test --match-path 'test/TransferOwnership.t.sol' -vv
```

## Tradeoffs and version notes

- **Executors = `[Safe]` (closed) vs `address(0)` (open)**. Closed = narrower
  attack surface (only the Safe can execute, so a frontrunner cannot weaponize
  a queued op). Open = better liveness if the Safe is unavailable. We default
  to closed; switch to `address(0)` only after a live operational reason.
- **OZ contracts v5.6.1 (TimelockController) + OZ contracts-upgradeable v4.9.6
  (Ownable, UUPS proxies)**. This is the current mixed state. When the
  upgradeable submodule is bumped to v5, the test's
  `vm.expectRevert(bytes("Ownable: caller is not the owner"))` lines must
  switch to `OwnableUnauthorizedAccount` custom errors. Search
  `test/TransferOwnership.t.sol` for `AUDIT:` markers.
