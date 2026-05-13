---
'@inferenceroom/pico-protocol': patch
'@inferenceroom/pico-sdk': patch
'@inferenceroom/pico-cli': patch
---

Round-3 mainnet smoke findings (issue #100) — fixes #4, #7, #9-#15.

**hub (#9-#11)**: §8 inbound-liquidity layer now works for native-ETH
channels. `defaultOfferAmount` resolves per-token (0.05 ETH for
native, 5 USDC for USDC), proposed offers re-push to the user on
every WS subscribe, and the chain-watcher bootstrap seeds a sentinel-
signed v0 state so the router can apply HTLC updates onto fresh
channels. Combined with PR #99 (CLI/SDK ETH support) and PR #102
(chain-watcher bootstrap), `pico pay --json` now returns
`status: settled` end-to-end for native ETH.

**SDK (#13)**: `ViemChainAdapter` writes use `maxFeePerGas = 4 ×
basefee + tip` (or `gasPrice = 4 × eth_gasPrice` on legacy chains)
so close/open/topup txs don't get stuck in mempool when viem's
default `eth_gasPrice` underestimates the chain floor.

**CLI (#4, #7, #14, #15)**: `pico channel open` exits 0 when only
the WS subscribe times out (the channel is on-chain and persisted);
checks `minChannelAmount[token]` before submission to surface a clear
error instead of `chain error: Contract Call:`. `pico channel close`
auto-routes to `close-from-open` when no off-chain state exists.
`pico keys drain` uses inflated gas math matching the SDK and swallows
native-sweep failures into a `nativeSkipped` warning so token sweeps
still count.

**release infra (#12)**: `release.yml`'s Docker-tag step now diffs
deploy-relevant package versions against the last `v*` tag rather
than gating on `changesets.outputs.published`. Combined with
`continue-on-error: true` on the changesets/action step, GKE deploys
fire reliably even when the (unrelated) npm publish 404 happens.

**hub (#3)**: `/v1/health.version` reports the real release tag
(`HUB_RELEASE_TAG` → `package.json` → `npm_package_version` →
`0.0.0`) instead of always `'0.0.0'`.

**CLI (#5, #6)**: `pico invoice create --amount` and `pico pay
--amount` help text is now token-agnostic. `pico channel open`/`close`
print the on-chain tx hash in both pretty and JSON output (verified;
README annotation updated).
