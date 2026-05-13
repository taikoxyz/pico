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
