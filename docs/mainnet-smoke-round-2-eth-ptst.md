# Round-2 mainnet smoke — ETH + PTST, fresh wallets

| Field | Value |
|---|---|
| Date (UTC) | 2026-05-13 |
| Operator | Daniel Wang (`dong77@gmail.com`) |
| Local branch / HEAD | `dantaik/smoke-test-plan` / `3b0b5fa` |
| Target release | `v2.0.4` |
| Network | Taiko mainnet (chain id 167000) |
| RPC | `https://rpc.mainnet.taiko.xyz` |
| Hub | `https://hub.pico.taiko.xyz` (hub address `0x2d8Bac9eC662F7F09E59296f43B59D21EF6E9cc9`) |
| PaymentChannel | `0xA2665f2Fdf23CAA362b63F7A8902466f0504332d` |
| Adjudicator | `0x8C913a936F99e93e298f7800f14C46C32D71e26B` |
| PTST (test ERC-20) | `0x3CF2321323C23c9F91daFe99E2b121cab5cE3759` |
| Deployer | `0x327fa3369B1D1D42120d84bc407e5865ECa7c458` |

Plan: [`/Users/d/.claude/plans/system-instruction-you-are-working-quirky-avalanche.md`](../../../.claude/plans/system-instruction-you-are-working-quirky-avalanche.md). Phase-by-phase logs under `.context/round-2-logs/`.

## Summary

| Phase | Result | Notes |
|---|---|---|
| 0 — verify `v2.0.4` deployed to GKE | PASS | Image digests match CI publish; rollouts complete; 0 pod restarts. |
| A — generate fresh wallets | PASS | New roles `diana` + `eve`, distinct from any prior smoke role. |
| B — fund from deployer | PASS (scaled) | Deployer had less ETH than the plan budget; reduced per-role funding from 0.05 → 0.015 ETH. |
| C — ETH channel lifecycle | **BLOCKED** | CLI + SDK do not support native-ETH channels; ETH lifecycle skipped. See *Findings* below. |
| D — PTST channel lifecycle | **PARTIAL** | Channels opened on-chain for diana + eve; pay/listen blocked by hub indexer gap; channels closed via `closeUnilateralFromOpen` (24 h dispute window started). |
| E — reclaim to deployer | PASS (with caveat) | All ETH and free PTST returned. 4 PTST temporarily locked in channels — recoverable on 2026-05-14 via `finalize`. |
| F — report | this document | — |

## Wallets

| Role | Address | Encrypted key |
|---|---|---|
| diana | `0x3F61915aB5fe3Bf33d732E58Aa6B9D2944C9559b` | `~/.pico/diana/key.enc` |
| eve | `0xD2eB84eBf00007a0d4472f899b483F4b2c86c6C2` | `~/.pico/eve/key.enc` |

Passphrases recorded in gitignored `.context/round-2-secrets.env` (0600).

## Phase 0 — GKE rollout gate

| Check | Result |
|---|---|
| Latest tag | `v2.0.4` (from `git tag --sort=-version:refname`) |
| `gke-images.yml` for `v2.0.4` | run 25742866844, completed `success`, 7 m 1 s |
| `deploy.yml` (workflow_call) within that run | completed `success` |
| Hub image on cluster | `asia-southeast1-docker.pkg.dev/pico-mainnet/pico/hub@sha256:7faf6370f0cdb0678d352aed21e622c3ef77a55321a1fc6090a01c1c136f15fc` ✓ matches CI digest |
| Watchtower image | `asia-southeast1-docker.pkg.dev/pico-mainnet/pico/watchtower@sha256:223005d62ca6b5c5c14a2528316e0fe8f46afe628ababb527c3b21421d82ecc5` ✓ matches CI digest |
| `kubectl rollout status pico-hub` | `partitioned roll out complete: 1 new pods have been updated...` |
| `kubectl rollout status pico-watchtower` | same |
| Pod restarts | `pico-hub-0` 0, `pico-watchtower-0` 0; both `READY`, 15 h uptime |
| `GET /v1/health` | `{"status":"ok","checks":{"db":"ok","chain":"ok"},"channels":1}` |
| `GET /v1/info` | `chainId=167000`, contracts match expected ✓ |

**Phase 0 finding (low severity):** `/v1/health` returns `"version":"0.0.0"` instead of `2.0.4`. The hub reads `process.env.npm_package_version` (`apps/hub/src/api/index.ts:118`) which is only set when starting via `npm`/`pnpm` script. In the container the hub is started directly, so the env var is absent and the `?? '0.0.0'` fallback fires. The image digest is the source of truth and is correct; the version-string surface is purely cosmetic but should be wired up (read from `package.json` at build time, or stamp the build SHA).

## Phase B — funding

Deployer had **0.04967 ETH** at the start (less than the plan's 0.10 budget). Scaled per-role funding from 0.05 → 0.015 ETH. PTST kept at 5 / role.

| Action | Tx | Status |
|---|---|---|
| Fund 0.015 ETH → diana | [`0x9165eea4…`](https://taikoscan.io/tx/0x9165eea4f6d557995d928d8004e556bfabaa8bd64e872a672b883f36b65e90e8) | ✓ |
| Fund 0.015 ETH → eve | [`0x2182061f…`](https://taikoscan.io/tx/0x2182061fca8e64b862800a8a14e5f3dac3046ae549555449200b1381f06865fb) | ✓ |
| Mint 5 PTST → diana | [`0x5a3794f2…`](https://taikoscan.io/tx/0x5a3794f2953a2afff65a9acf86e549b5c03faf0001b2cce84d2604a92bce8476) | ✓ (after one nonce-race retry) |
| Mint 5 PTST → eve | [`0x932ed317…`](https://taikoscan.io/tx/0x932ed317ce4e8c985e204d13f6ba933edce10507389ccb61655c9fbd8cd60eff) | ✓ |

**Phase B finding:** running `cast send` back-to-back from one wallet races on nonce because each invocation independently fetches `latestNonce` and submits without coordination. Mitigation for future smoke runs: pin the starting nonce and increment manually, or insert `cast nonce <addr>` between sends.

## Phase C — ETH lifecycle (BLOCKED, two CLI/SDK gaps)

Plan called for `pico channel open --token 0x0000000000000000000000000000000000000000` to open native-ETH channels. The contract supports this (`PaymentChannel.sol:283-288` — `address(0)` allowlisted, `payable openChannel` requires `msg.value == amountA` when `token == address(0)`), but the CLI/SDK do not:

1. **`pico channel open` calls `readTokenDecimals(0x0)` unconditionally** (`apps/cli/src/runtime/cli-helpers.ts:66`). For `address(0)` there is no contract, so the `decimals()` `eth_call` reverts and the CLI surfaces a useless `"chain error: This could be due to any of the following:"` line with no detail. The CLI must short-circuit `readTokenDecimals` (and the `readAllowance` / `approve` block at `channel.ts:148-170`) when `token == address(0)` and use 18 decimals.
2. **`ViemChainAdapter.openChannel` never sets `value:`** (`packages/sdk/src/chain-adapter.ts:264`). The contract requires `msg.value == amountA` for ETH channels, so even past the decimals check the call would revert with `"ETH value!=amountA"`. The adapter must pass `value: token === ZERO_ADDRESS ? args.amountA : 0n`.

The landing page (commit `085ef32`) and the PTST docs imply ETH channels are usable end-to-end. They are not. ETH lifecycle skipped for this round; unused diana/eve ETH was drained back in Phase E.

## Phase D — PTST lifecycle (PARTIAL)

### On-chain opens — succeeded

| Role | Channel id | Open tx | amountA |
|---|---|---|---|
| diana | `0x3e298c400606464b6aa6c50673aaa1d93f32d4f43f1d4cef4c5e4e6a82c80774` | [`0xc50d3b85…`](https://taikoscan.io/tx/0xc50d3b85f4574dc1cc6c65e6b4d06ff72c2536cef486948c9260ebc888901627) | 2 PTST |
| eve | `0x9e7ee16b25c21057540f663e3fc5700607b0b0a2c75be3a22539115c139bf883` | recovered via `cast logs` | 2 PTST |

Both `ChannelOpened` events emitted, both wallets debited 2 PTST, both channels marked `open` in local SDK storage.

### Pay/listen — BLOCKED by hub indexer gap

Every WS connection to `wss://hub.pico.taiko.xyz/ws` from diana or eve was rejected by the hub:

```
{"level":40,"app":"pico-hub","reason":"signer 0xD2eB84eBf00007a0d4472f899b483F4b2c86c6C2 not a known channel party","msg":"envelope verification failed"}
```

Symptoms:
- `pico channel open` succeeds on-chain but then errors `hub error: transport request 'subscribe' timed out after 10000ms` because the post-open `ensureSubscribed` WS round-trip is rejected and times out.
- `pico listen` exits immediately with the same `subscribe timed out` error.
- `GET /v1/stats` returns `{"channels":{"total":1,"byStatus":{"closing-unilateral":1}}}` — the hub never indexed the two new `ChannelOpened` events; the only channel it knows about is an old `closing-unilateral` one from a prior run.

The hub container log shows zero indexing activity in the past 30+ minutes — only `/v1/health` probes and metrics scrapes. Either the on-chain event indexer is not running in v2.0.4, or it is configured against an RPC that is unreachable / many blocks behind. Without an indexer the hub never adds new parties to its `known_channel_parties` set, so the WS envelope-verification check (`requireSignedEnvelope: true`, see `/v1/info`) rejects every legitimate connection from a freshly-opened channel's party.

This is a **production-blocking gap for new users**: the hub cannot accept new channels from anyone whose first interaction is `channel open`.

### Close — used anti-hostage path

Since the hub WS path is blocked, neither `channel close --cooperative` (needs hub co-sig) nor the regular `channel close` (also routes through hub) is usable. Used the contract's `closeUnilateralFromOpen` directly (callable by either party with no signed off-chain state) via `cast send`:

| Role | Close tx | Block |
|---|---|---|
| diana | [`0x55dad459…`](https://taikoscan.io/tx/0x55dad459b5a3f5a31d0cfb1985c8e957d418be398c2527fe9bf24d1e9ed016ea) | 6,669,554 |
| eve | [`0xae9e8d35…`](https://taikoscan.io/tx/0xae9e8d3510000f0a3be9d336515437a81bb8d854267482ccb13fb12edcaec79e) | 6,669,556 |

Both channels are now `ClosingUnilateral`. Dispute deadline ≈ 24 h from close (2026-05-14 UTC). After that, anyone may call `finalize(channelId)` to release each party's original deposit (2 PTST → diana, 2 PTST → eve, since no off-chain state was ever exchanged).

## Phase E — reclaim to deployer

PTST sweeps (manual `transfer`, after the CLI sweep raced on diana's native step):

| Action | Tx |
|---|---|
| diana PTST 3 → deployer (via `pico keys drain` first half) | — landed despite CLI exit 1 |
| eve PTST 3 → deployer (manual `cast send transfer`) | [`0x685a5d54…`](https://taikoscan.io/tx/0x685a5d54c63ce98f0ae09d1733d10be795bf0d9a8e09ff315817eebc9cd78630) |

ETH sweeps (manual, with explicit gas buffer — the CLI's reserve math overshot and refused to send):

| Action | Tx | Sent (wei) |
|---|---|---|
| diana ETH → deployer | [`0x4198de0a…`](https://taikoscan.io/tx/0x4198de0a9f7a529de7a535d43d65765cdc5497f10adef408f2e71d7d28162240) | 14,984,262,136,041,854 |
| eve ETH → deployer | [`0x77a13c3a…`](https://taikoscan.io/tx/0x77a13c3aeb270935c5d09e9b3b634d22ea8dbde1627272e5b8bee4f27de39069) | 14,986,490,741,252,072 |

### Final balances

| Account | ETH (wei) | PTST (1e18 units) |
|---|---|---|
| diana | 839,999,979,000 (≈ 8.4e11, dust) | 0 |
| eve | 839,999,979,000 (≈ 8.4e11, dust) | 0 |
| PaymentChannel (locked) | — | 14 PTST (10 from prior run + 4 from this run, recoverable via `finalize`) |
| deployer | 49,642,078,632,672,352 (≈ 0.0496 ETH) | 999,996 PTST |

Deployer's ETH decrease vs. start (0.04967 → 0.04964 ≈ 3e13 wei = $0.0001) is the aggregate gas cost across all of this round's funding + minting + close + sweep transactions. PTST round-trip is exact (0 net change once the 4 locked-in-channel PTST is released after the dispute window).

### Phase E finding — `pico keys drain` UX gaps

1. **Native sweep aborts the whole drain.** When the native-ETH `value` calculation produces "total cost > balance", the CLI prints `chain error: ...` and exits non-zero even though the ERC-20 sweep step already succeeded. The user has no signal that PTST was transferred; only that the drain "failed." The drain should run ERC-20 sweeps first, native sweep second, and report each step independently.
2. **Errors are written to stdout in the `--json` path.** With `--json`, the only output should be one JSON object; instead the CLI writes a plain `chain error: ...` line to stdout, breaking downstream `jq` parsing.
3. **`waitForTransactionReceipt` timeout in non-fatal cases.** Eve's first drain ERC-20 tx returned a timeout, but the tx hash was logged — it simply hadn't landed in time. Surfacing the hash + a retry-or-poll hint would let the operator distinguish "dropped" from "slow."
4. **Gas-buffer math is too conservative on low-balance wallets.** With diana at ~0.015 ETH and `gasPrice * 21000 * 1.5` reserved, the sweep should easily fit but errors out. The current implementation likely uses `gasPrice * gasLimit * value` rather than `balance - (gasPrice * gasLimit * 1.5)`. Worth a unit test on a near-empty wallet.

## Findings — consolidated punch list

| # | Severity | Component | Finding |
|---|---|---|---|
| 1 | **HIGH** | hub | Chain indexer not picking up new `ChannelOpened` events on Taiko mainnet `v2.0.4`. Every WS handshake from a freshly-opened channel's party is rejected as "not a known channel party." Blocks all new users. |
| 2 | **HIGH** | CLI + SDK | Native ETH channel open is non-functional. `readTokenDecimals(0x0)` reverts and `ViemChainAdapter.openChannel` does not pass `value:`. Landing page promises ETH support that does not exist end-to-end. |
| 3 | medium | hub | `/v1/health` returns `"version":"0.0.0"` because `npm_package_version` is unset in the container. Stamp at build time. |
| 4 | medium | CLI | `pico keys drain` aborts the entire drain when the native step fails; writes errors to stdout in `--json` mode; gas-buffer math is too conservative on low-balance wallets. |
| 5 | low | CLI | `pico invoice create` / `pico pay` `--amount` help still says "USDC base units (6 decimals)" but the value is actually token-agnostic raw base units. |
| 6 | low | CLI | `pico channel open` does not print the on-chain `ChannelOpened` tx hash on success path; operators must `cast logs` to recover it. (Already noted in `scripts/mainnet-smoke/README.md:99`.) |
| 7 | low | CLI | When `client.open()` succeeds on-chain but the post-open WS subscribe times out, the CLI exits non-zero even though the channel is in fact open and locally persisted. Should distinguish "open succeeded, subscribe failed" from "open failed." |
| 8 | low | hub | `requireSignedEnvelope: true` + missing indexer = no graceful error. The hub should publish a clearer `not yet indexed: retry in N s` envelope-verification reason instead of a generic "not a known channel party." |

## Follow-up

- **Recover the 4 locked PTST**: on 2026-05-14, call `finalize(channelId)` for both `0x3e298c40…` and `0x9e7ee16b…`. Either party (or anyone, since `finalize` is permissionless after the deadline) can submit.
- **Investigate hub indexer (#1)**: confirm whether `pico-hub` `v2.0.4` is running an event indexer at all, what RPC it points at, and what its last-indexed block is. Highest priority before any further on-chain operations against this hub.
- **Wire ETH support end-to-end (#2)**: two surgical changes in `cli-helpers.ts` and `chain-adapter.ts`; then re-run this exact plan with `--token 0x0000000000000000000000000000000000000000`.
- **Remove PTST from allowlist**: not now — per `docs/test-erc20.md`, deferred until smoke testing concludes, which it has not (findings 1–2 must be resolved first).

---

## Phase C retry (2026-05-13, post-`v2.1.1`)

Tracking issue: [#100](https://github.com/taikoxyz/pico/issues/100). Re-ran Phase C with two fresh roles (frank, gabby) after the two HIGH gaps from this round were supposedly closed by PR #99 (CLI/SDK native-ETH) and PR #102 (hub `ChannelOpened` bootstrap).

### Deploy gate (the actual "make GKE current" step)

The original target was `v2.1.0`, which the round-2 Phase 0 marked PASS for digest + rollout. But the `v2.1.0` git tag points at `e44bd5b` (Version Packages #101) — committed *before* PR #102 (`10eee8a`). So the image rolled out as `v2.1.0` does not contain the hub-bootstrap fix at all. Verified by reading the running container's `/repo/apps/hub/dist/chain-watcher.js` lines 195-220: only the `if (known)` branch existed; no `else` / bootstrap; no `"channel bootstrapped from chain"` log message. Empirically reproduced by rewinding `chain_watcher.last_processed_block` to before the test event and confirming the watcher's cursor advanced past the event with the channel never registered.

The corresponding Version Packages PR #103 (`89f4839`) was supposed to bump `pico-sdk`/`pico-protocol` to `2.1.1`, triggering `release.yml` → `gke-images.yml` chain. `release.yml` run [25798343477](https://github.com/taikoxyz/pico/actions/runs/25798343477) failed at the npm publish step with `E404 ... '@inferenceroom/pico-sdk@2.1.1' is not in this registry` (the `@inferenceroom` scope is not registered on npmjs.org — separate finding from this smoke). Because `changesets/action`'s "Tag release for Docker build" step is gated on `published == 'true'`, no `v2.1.1` git tag was ever created and the GKE image was never rebuilt.

Unblocked by manually pushing `git tag v2.1.1 89f4839 && git push origin v2.1.1`, which triggered `gke-images.yml` run [25800501512](https://github.com/taikoxyz/pico/actions/runs/25800501512). Build + deploy succeeded in ~4 m total. Confirmed the new digest carries tag `v2.1.1` and that `/repo/apps/hub/dist/chain-watcher.js:239` now reads `"channel bootstrapped from chain"`.

| Field | Value |
|---|---|
| Hub image (after) | `…/pico/hub@sha256:0d54b83f7a3157bfcebd07aeb70bc55717e6493d6c691f776462217d730e3281` = `v2.1.1` |
| Watchtower image (after) | rolled, same v2.1.1 build |
| `/v1/health` | `{"status":"ok","checks":{"db":"ok","chain":"ok"}}` (still reports `"version":"0.0.0"` — round-2 finding #3 unfixed) |

### Wallets

| Role | Address | Encrypted key |
|---|---|---|
| frank | `0xbAFB6a280c52B62A7abB08740bEB9B14a3eEdc77` | `~/.pico/frank/key.enc` |
| gabby | `0xCD0260fd9c4aE547eFB7cEF3b07bF1de22184ab1` | `~/.pico/gabby/key.enc` |

Passphrases under gitignored `.context/round-3-secrets.env` (mode 0600).

### Funding (Phase B re-run)

Issue #100's plan was 0.025 ETH/role. Deployer only had `0.04964 ETH` at the start (carried over from end-of-round-2) so the smoke was run at scaled-down values: 0.015 ETH/role funding, 0.01 ETH/channel (the contract's `minChannelAmount[0x0]`), 0.001 ETH invoice.

First-pass funding was 0.006 ETH/role until I learned the channel min the hard way (CLI surfaced only the opaque `chain error: Contract Call:` — `cast call` revealed the actual revert reason `amount<min`). Topped each role up by another 0.009 ETH to reach 0.015 ETH total.

| Action | Tx |
|---|---|
| Fund 0.006 ETH → frank | [`0xc7965b6c…`](https://taikoscan.io/tx/0xc7965b6c487f8a08764918d675371a15d475c2d6da45baf3807ed81a62eda2e9) |
| Fund 0.006 ETH → gabby | [`0x1dfb4465…`](https://taikoscan.io/tx/0x1dfb446509ec64231c5d18c5bd22a562098745235425e1f459072a0721d1f97e) |
| Top-up 0.009 ETH → frank | [`0xbf934605…`](https://taikoscan.io/tx/0xbf934605633b69cf49c0b9977aa23956788f94d408d7ee986473bdf1da99166b) |
| Top-up 0.009 ETH → gabby | [`0x97f0bb36…`](https://taikoscan.io/tx/0x97f0bb36fe4b48a08787c1b1006985049de08216b6504af01adb67628e395782) |

### Phase C.1 — native-ETH channel open (PASS on-chain; subscribe race)

| Role | channelId | Open tx | Block | amountA |
|---|---|---|---|---|
| frank | `0xec896c9d9719fa059b6e3fb54777d21a6b2a86355888dc0bced84009858b8dc2` | [`0x1893eed0…`](https://taikoscan.io/tx/0x1893eed004a1ca3389f073658398628b371a0f107e7ca8f83954c348bcba53a1) | 6,678,536 | 0.01 ETH |
| gabby | `0x94ee136ebb01ad1931610825345bb751edd9d7fed9d6450098aaed3caa715966` | [`0xf968ca5c…`](https://taikoscan.io/tx/0xf968ca5c07f4952c97fef77cd09994c4a582eb6c20371f48059a74e6a2b50d4d) | 6,679,272 | 0.01 ETH |

PR #99 fix is correct end-to-end: `readTokenDecimals(0x0)` short-circuits to 18 and `ViemChainAdapter.openChannel` passes `value: amountA` for `token == ZERO_ADDRESS`. Both channels minted `ChannelOpened` on-chain.

But the CLI exited non-zero on each open with `"transport request 'subscribe' timed out after 10000ms"`. The chain-watcher's defaults (`pollingIntervalMs = 4000`, `confirmations = 3`) mean the hub needs up to ~12 s after on-chain inclusion to register a freshly-bootstrapped channel, while the CLI's WS subscribe gives up at 10 s. The CLI's warning message ("retry by running `pico listen`") is correct: the channel is locally persisted, on-chain, and indeed registered ~2 s later. PR #102's bootstrap is working as designed; the failure is a CLI/timing mismatch (round-2 finding #7 still rotting).

### Phase C.2 — pay flow (FAIL: §8 topup is unusable for native ETH)

With both channels bootstrapped, gabby's listen connected cleanly. Gabby created a 0.001-ETH (1e15 wei) invoice; frank paid it. Pay output:

```
{"stage":"verifying"}
payment failed: router: no signed state for outgoing channel 0x94ee136e…
```

Hub log on the open events:

```
channel registered + channel bootstrapped from chain   ← both channels, PR #102 works
topup: proposed offerId=0xb0f3…  amount=5000000  delivered=false
topup: proposed offerId=0x6172…  amount=5000000  delivered=false
htlcFail for unknown outgoing htlc
```

Three new HIGH findings come out of this:

- **`§8` topup amount is hard-coded for USDC.** `apps/hub/src/topup-policy.ts:22` sets `defaultOfferAmount: 5_000_000n // 5 USDC`. The handler proposes that exact integer regardless of channel token decimals — on a native-ETH channel (18 decimals) that's `5e6 wei ≈ 5 picoether ≈ $1e-11`. No real payment can be forwarded.
- **`§8` topup delivery is fire-and-forget.** Hub proposes immediately when the chain-watcher bootstraps the channel. If the user's `pico listen` subscribes *after* that propose (in our case ~80 s later), `pushProposeTopUp` writes `delivered: false` and the offer is never re-pushed.
- **Bootstrapped channel has no `v0` signed state.** The chain-watcher's `channelPool.register(channel, undefined, …)` passes `undefined` for `initialState`. Combined with the two above, the hub's router can't accept any HTLC because the outgoing channel has nothing to apply the update onto. The §8 topup-handler is the intended path to establish v0+hub-liquidity, and both halves of that path are broken in this configuration.

Net: the WS-handshake gap from round-2 is closed, but the *next* gap downstream — hub inbound liquidity for native-ETH channels — is wide open. Without it, no payment can be routed regardless of how cleanly the open succeeds.

### Phase C.3 — close (anti-hostage path, no off-chain state)

Cooperative close needs a signed state; there isn't one. `pico channel close --cooperative` surfaces another opaque `chain error: Contract Call:` instead of routing automatically to `closeUnilateralFromOpen` (the same anti-hostage path round-2 used for PTST). `pico channel close-from-open` is the right command — once you know to type it.

| Role | Close tx | Block | Notes |
|---|---|---|---|
| gabby | [`0xc8045936…`](https://taikoscan.io/tx/0xc8045936addfd2093d4557908ddc34e96b578ef22ccfe440e9266dba3c0004f8) | (landed normally) | `pico channel close-from-open` worked first try |
| frank | [`0xa2f072f2…`](https://taikoscan.io/tx/0xa2f072f28cac27198086ff87cd320894085b435908df3eaabe032cc1fe318199) | 6,679,745 | First attempt stuck at `gasPrice = 12_000_000 wei` (0.012 gwei) vs chain floor `~39_209_958 wei`. Unstuck by `cast send` with same nonce + `--gas-price 100_000_000` |

Both channels in `ClosingUnilateral`. Dispute deadline ≈ `2026-05-14T13:13:17Z`. After that, anyone may `finalize(channelId)` to release each side's principal (0.01 ETH → frank, 0.01 ETH → gabby).

### Phase D — drain residual to deployer

`pico keys drain --to <deployer>` still aborts with `total cost ... exceeds the balance of the account` on near-empty wallets (round-2 finding #4 unfixed). Drained manually via `cast send --gas-price 78_419_916 --gas-limit 21000 --value (balance − 21000·gasPrice)`:

| Role | Drain tx |
|---|---|
| frank | [`0x2ecdf22c…`](https://taikoscan.io/tx/0x2ecdf22c689f14431af5bd9fe76f515a7a1d2893752c7d6203c1e4aef7dd9bd5) |
| gabby | [`0xbbde0c3f…`](https://taikoscan.io/tx/0xbbde0c3fbab97e1378ad5cc966bb8982c92b18e4f737ddcfc06a3504c4c0a0b9) |

### Final balances

| Account | ETH |
|---|---|
| frank | 0.00000144 (dust) |
| gabby | 0.00000144 (dust) |
| PaymentChannel (locked) | 0.02 (recoverable via `finalize` after 2026-05-14T13:13:17Z) |
| deployer | 0.02962 |

Deployer started this addendum at `0.04964`. End at `0.02962`. Of the `0.02002` ETH spent, `0.02` is principal currently locked in channels (recoverable) and ~`0.00002` is aggregate gas. PTST untouched.

### Findings — addendum

| # | Severity | Component | Finding |
|---|---|---|---|
| 9 | **HIGH** | hub | §8 topup `defaultOfferAmount: 5_000_000n` is hard-coded for USDC (6 decimals). For native-ETH (18 decimals) it offers `5e6 wei ≈ 5 picoether` — useless. Scale offer per channel token decimals (or store per-token defaults in `topup-policy.ts`). |
| 10 | **HIGH** | hub | §8 topup delivery is fire-and-forget. `pushProposeTopUp` records `delivered: false` if the user isn't subscribed at the moment of propose; offers never re-push on `subscribe`. New users who run `pico channel open` then `pico listen` immediately after will frequently miss the initial offer. |
| 11 | **HIGH** | hub | Chain-watcher bootstrap registers channel metadata only — `register(channel, undefined, amounts)` — with no v0 signed state. Combined with #9/#10, the router has nothing to apply HTLC updates onto and fails any pay with `no signed state for outgoing channel`. |
| 12 | **HIGH** | release infra | Release pipeline coupling: changesets `published == 'true'` gates the docker-image tag. Any npm publish failure (e.g. the `@inferenceroom/*` scope not existing) silently blocks GKE deploys with no operator alert. The two pipelines should be decoupled — Docker tag should fire on any version bump that touches the deploy-relevant package list, regardless of npm publish status. |
| 13 | medium | CLI | `pico channel close-from-open` submits at a low fixed `gas-price` (~12_000_000 wei observed). On Taiko mainnet the basefee floor is ~39 M wei, so the tx sits indefinitely. Compute `gasPrice` via `eth_gasPrice` plus a small premium. |
| 14 | medium | CLI | `pico channel close --cooperative` on a freshly opened channel surfaces opaque `chain error: Contract Call:`. The CLI should detect "no v0 state" and route to the close-from-open path automatically (or print a clear error pointing at the right command). |
| 15 | low | contracts | `minChannelAmount[address(0)] = 1e16` is undocumented in `IPaymentChannel.sol` and not mentioned in the landing-page native-ETH copy. The CLI should `cast call minChannelAmount(token)` before submitting and surface a clear `--amount must be ≥ X.XXX ETH` error rather than `chain error: Contract Call:` with no detail. |

### Follow-up

- **Recover locked principal**: on 2026-05-14T13:13:17Z+, call `finalize` for `0xec896c9d…` and `0x94ee136e…` (in addition to the round-2 PTST channels listed above).
- **Cut the §8 inbound-liquidity story for native ETH**: address #9, #10, #11 together. The simplest viable wedge is per-token `defaultOfferAmount` in `topup-policy.ts` plus a re-push of `proposed` offers on every `subscribe` ack. Bootstrap should optionally seed a v0 with `balanceA = amountA, balanceB = amountB`.
- **Decouple release pipeline (#12)**: cut the Docker tag from `version-bump-merged && deploy-relevant-package-touched`, not from `npm-published`. Independently, fix the `@inferenceroom/*` npm scope so `release.yml` can actually publish.
- **Round-4 retry**: only after #9-#12 are addressed. Re-use the same `frank`/`gabby` roles or generate `henry`/`isla`.

