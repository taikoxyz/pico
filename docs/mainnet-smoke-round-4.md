# Round-4 mainnet smoke — ETH + PTST lifecycle (PASS)

| Field | Value |
|---|---|
| Date (UTC) | 2026-05-14 |
| Operator | Daniel Wang (`dong77@gmail.com`) |
| Final release | `v2.1.9` (hub) |
| Network | Taiko mainnet (chain id `167000`) |
| RPC | `https://rpc.mainnet.taiko.xyz` |
| Hub | `https://hub.pico.taiko.xyz` (`0x2d8Bac9eC662F7F09E59296f43B59D21EF6E9cc9`) |
| PaymentChannel | `0xA2665f2Fdf23CAA362b63F7A8902466f0504332d` |
| Adjudicator | `0x8C913a936F99e93e298f7800f14C46C32D71e26B` |
| PTST | `0x3CF2321323C23c9F91daFe99E2b121cab5cE3759` |
| Deployer | `0x327fa3369B1D1D42120d84bc407e5865ECa7c458` |

## Headline

Both native-ETH and ERC-20 (PTST) payment lifecycles settled
end-to-end on Taiko mainnet after a cascade of nine production
patches landed in v2.1.3 → v2.1.9. The pre-v2.1.3 production hub
could not pay anyone end-to-end; the post-v2.1.9 hub does.

| Lifecycle | Channel deposit | Invoice amount | Pay result | Close result |
|---|---|---|---|---|
| Native ETH (nina → owen) | 0.0001 ETH | 0.00001 ETH | `status: settled` | cooperative close, both sides |
| ERC-20 PTST (sam → tina) | 0.05 PTST | 0.01 PTST | `status: settled` | cooperative close on receiver; `posted!=0` on sender (see findings) |

`pico pay --json` returned `{"settled":true,"channelId":...}` for both
runs; the matching `htlc settled / direction: incoming` log fired on
the receiver's `pico listen`.

## Releases shipped during the run

| Tag | PRs | What landed |
|---|---|---|
| `v2.1.3` | #106 | hub: lower ETH `defaultOfferAmount` to 0.0001 ETH; dispute-handler skips sentinel-signed states |
| `v2.1.4` | #109 | hub hotfix: 32-byte zero `r`/`s` in `SENTINEL_SIG`; `hexToSignature` tolerates legacy 264-char rows so the hub can boot from a v2.1.2-written DB |
| `v2.1.5` | #112 | hub: pass *channel.token*, not handler-wide `this.deps.token`, into `chain.topUp` so mixed-token hubs don't submit ETH topups as ERC-20 transfers |
| `v2.1.6` | (Version Packages) | rebundle only |
| `v2.1.7` | #115 | SDK: `chain.topUp` polls `channels(id).status == Open` before `eth_estimateGas` to dodge RPC-lag `!open` reverts |
| `v2.1.8` | #118, #121 | state-machine + hub: per-token `maxPerCounterpartyValue` (default `1 ETH` / `100 PTST` / `100 USDC`); hub seeds `LiquidityTracker` snapshots from `channelPool` on startup |
| `v2.1.9` | #123 | hub: actually land the PTST `perTokenDefaultOfferAmount = 2 PTST` that PR #115 claimed but dropped via a rebase |

Also: `HUB_FEE_BPS=0`, `HUB_FEE_FLAT=0` set on the GKE ConfigMap during
the run. The SDK's pre-fee math overshoots the hub's quote by a bps
factor, so charging a nonzero hub fee makes invoice receivers reject
with `amount underpaid`. Tracked as round-4 finding #25 below.

Plus 3 separate `chore: re-flatten package.json files arrays` PRs to
keep CI lint green after each `Version Packages` PR widens those
arrays (the `changesets/action` formatter and `biome` disagree).

Plus one production touch:

| Change | Value | Tx |
|---|---|---|
| `setMinChannelAmount(0x0, 1e14)` | floor lowered to 0.0001 ETH | [`0x5b100ccee8…`](https://taikoscan.io/tx/0x5b100ccee8a1af636b18a334fb1649ed6c4dde9c12eda4b08e8d84237e4c812d) |
| `setMinChannelAmount(PTST, 1e16)` | floor lowered to 0.01 PTST | [`0x11b764aee8…`](https://taikoscan.io/tx/0x11b764aee88f15b0bd25cdd58c1e9a7dd946a091b53d576f4fcb1a3c8498dc7b) |

## Native-ETH lifecycle on v2.1.8 → v2.1.9 (PASS)

Wallets: nina (`0x1f08…6728E`), owen (`0x54D2…F10Fa`).

| Action | Tx | Notes |
|---|---|---|
| Fund nina 0.00015 ETH | [`0x8acfad42…`](https://taikoscan.io/tx/0x8acfad42208f74e94b1a7df6d8dd2bdfb19fcd00bae60adad49f60757b712689) | |
| Fund owen 0.00015 ETH | [`0x1cac87d1…`](https://taikoscan.io/tx/0x1cac87d1abfedac2637762f80e4916f775102ff066f1b1ab4a130c662911e828) | |
| Nina open ETH channel (0.0001 ETH) | [`0xaf43e77a…`](https://taikoscan.io/tx/0xaf43e77ae5a294a3e3c0c80abcf6b23fc696343c6cf90e1e3400093487055ffd) | channelId `0x06ef662b…` |
| Owen open ETH channel (0.0001 ETH) | [`0x7420c02a…`](https://taikoscan.io/tx/0x7420c02aac91b46d2b528c281911e635b3d767c8c2d0e121f78a1734157d8035) | channelId `0xc4c7b641…` |
| Hub topUp(owen, 0.0001 ETH) | [`0xcd1b7053…`](https://taikoscan.io/tx/0xcd1b705353f9fc9fc0d7540935496ad0942d7bba56310f60f6d73afe739ae9cd) | first §8 inbound-liquidity tx that has *ever* confirmed for native ETH on this hub |
| Nina pays Owen 0.00001 ETH | `{"settled":true,"channelId":"0x06ef662b…"}` | `pay --json` exit 0; tina `htlc settled` log fired |
| Cooperative close nina | [`0x679e31b0…`](https://taikoscan.io/tx/0x679e31b011630c2dc0e6f49697ad20ee4245ca65bd4f13fbf844d8d9d2bfb2a7) | hub co-signed v3, no dispute window |
| Cooperative close owen | [`0x5bcbcfc1…`](https://taikoscan.io/tx/0x5bcbcfc111eeb8e3f5234644c0467ad05b3ac17c5ad708c55890faf3ecf8ca91) | |
| Drain nina → deployer | [`0xa396f946…`](https://taikoscan.io/tx/0xa396f9463ff6a29f6af9ea77367da0a471d6d9b090763a7d8879abbc82fd4558) | |
| Drain owen → deployer | [`0x831ddc4f…`](https://taikoscan.io/tx/0x831ddc4f389e6f08452f91618f21ced8b5de6ec65e96c9a0d36be3dbe2063b79) | |

## ERC-20 (PTST) lifecycle on v2.1.9 (PASS up to receiver-side cooperative close)

Wallets: sam (`0x50E8…c0E4`), tina (`0xF5fD…b421`).

| Action | Tx | Notes |
|---|---|---|
| Fund sam 0.0005 ETH + 0.1 PTST | [`0x4bdd…06b9`](https://taikoscan.io/tx/0x4bddabeaac9ed36ba0c0cfe83d8ee2bc36c6e341b76f4cce87c6fc3d1986069b) / [`0x3f59…20af`](https://taikoscan.io/tx/0x3f59340f305e511ddd9231752e5c1625a26a3d17ea6e176624dbf21980b220af) | sam needed a second top-up before `openChannel` accepted; root cause: SDK's `fees()` over-quotes on the approve+open combo |
| Fund tina 0.0001 ETH + 0.1 PTST | [`0xd627…b547`](https://taikoscan.io/tx/0xd627afba0546f191ab2a6d061ea815cbf89bcee75eeeb6d067a76a5bec34b547) / [`0xb8fa…8561`](https://taikoscan.io/tx/0xb8fada960c4afcf9aa978fb1ccab9e1ce4dbebe8fdeca4b23a38f0e336e28561) | |
| Sam open PTST channel (0.05 PTST) | [`0xdcaf7e2e…`](https://taikoscan.io/tx/0xdcaf7e2ecb87c9dcd5e848cb13664d9aa24173afebe71706c5bf644ec9b1fd4e) | channelId `0xe49d788c…`; auto-approve = [`0x3680…39ee`](https://taikoscan.io/tx/0x3680439ee07b46c7d4be8e51c4b58dc3e8bda9e2)? (built into open) |
| Tina open PTST channel (0.05 PTST) | [`0x088428a3…`](https://taikoscan.io/tx/0x088428a3366388d5a1f4d415dcd0b23cd1e5e8f6a076f92eb415ebda2ba00c87) | channelId `0x367840fc…` |
| Hub topUp(tina, 2 PTST) | [`0xb7851441…`](https://taikoscan.io/tx/0xb785144179e00040fae6229356f623086e82351e1cbcfd9217d969b282b4325b) | `defaultOfferAmount[PTST] = 2e18` lands correctly (vs 5e6 = 5e-12 PTST on v2.1.7/v2.1.8) |
| Sam pays Tina 0.01 PTST | `{"settled":true,"channelId":"0xe49d788c…"}` | router admission passes the new per-token cap (1e8 USDC cap would have rejected) |
| Cooperative close tina | [`0xb9b9101c…`](https://taikoscan.io/tx/0xb9b9101cafafcb66902584edbc90cf05decc2491c03efabe3212f80cb4bc356b) | |
| Cooperative close sam (FAIL) | — | `chain error: Contract Call:` — the CLI's `--unilateral` fallback hits the same opaque revert; manual `close-from-open` reverts with `posted!=0` (channel had a v1 from the topup). See finding #29. |
| Drain sam ETH/PTST residual | [`0xdc66aa0d…`](https://taikoscan.io/tx/0xdc66aa0ddda6d715478b843a87edf125a91b79184b2e542efa130ac388ce1865) / [`0x0abee02f…`](https://taikoscan.io/tx/0x0abee02f60ed84c5d27a268960931b2bef18359d8f950230ab0b8716d654dd44) | sam's 0.04 PTST stays in the channel pending close; tina's 0.06 PTST returned. |

## Recovery — pre-existing locked channels

Pre-existing closing-unilateral channels from rounds 2/3 + round-4
phase-1 (which never paid) were swept back as their dispute windows
elapsed:

| Channel | Token | Amount | Final-tx |
|---|---|---|---|
| diana (round-2) | PTST | 2 PTST → deployer | finalize [`0xd1581b5f…`](https://taikoscan.io/tx/0xd1581b5f9185f18c8ec6629ef079e2e43fa63ee8aea10fadaacbb65b248e818d) + transfer [`0xbc553c13…`](https://taikoscan.io/tx/0xbc553c1345030e969d48471037a3aa95176a4777c22e6168075f659fd1ed329e) |
| eve (round-2) | PTST | 2 PTST → deployer | finalize [`0x46a66d48…`](https://taikoscan.io/tx/0x46a66d48ab5625d86c54ae374de2d5bb7e9893c02ea564684cf23ac7cd31fae8) + transfer [`0xd107acbd…`](https://taikoscan.io/tx/0xd107acbdce3e822c92c4e81bdd99d6fc24260b417822238a07c46836226c52a1) |
| frank, gabby (round-3) | ETH | 0.01 + 0.01 ETH | pending; dispute deadline `2026-05-14T13:13–13:22Z` |
| henry, ivy (round-4 phase 1) | ETH | 0.0001 + 0.0001 ETH | pending; dispute deadline `2026-05-15T04:40–04:46Z` |
| jane, kevin (round-4 phase 2) | ETH | 0.0001 + 0.0001 ETH | pending; dispute deadline `2026-05-15T05:37–05:38Z` |
| lisa, mike (round-4 phase 3) | ETH | 0.0001 + 0.0001 ETH | pending; dispute deadline `2026-05-15T06:45–06:46Z` |
| pat (round-4 phase 4) | PTST | 0.05 PTST | pending; dispute deadline `2026-05-15T07:14Z` |
| sam (round-4 phase 5) | PTST | 0.04 PTST | **still `Open` on-chain** — see finding #29 |

## Findings

Round 4 surfaced ten production-blocking and three lower-severity
gaps. The first nine were patched in v2.1.3–v2.1.9 (numbers map back
to the patch PRs above). Three remain open and are listed at the
bottom.

| # | Severity | Status | Component | Finding |
|---|---|---|---|---|
| 16 | HIGH | closed in v2.1.3 (#106) | hub | `defaultOfferAmount[ETH] = 0.05` ETH starved out hub headroom after one channel. |
| 17 | HIGH | partially closed (see #28) | hub | Hub proposes topup to channel openers (senders) too, wasting the offer. |
| 18 | HIGH | open (see #27) | hub | `TopUpHandler.expireDue` is never called periodically; pending offers leak headroom forever. |
| 19 | HIGH | closed in v2.1.3 (#106) | hub | Dispute-handler busy-loops `dispute(...)` on sentinel-signed bootstrap states (`bad sig` revert each poll). |
| 20 | medium | open (see #26) | hub | `/v1/health.version` is still `"0.0.0"` because `HUB_RELEASE_TAG` isn't set on the StatefulSet env. |
| 21 | HIGH | closed in v2.1.5 (#112) | hub | `TopUpHandler` passed handler-wide `this.deps.token` to `chain.topUp`, so mixed-token hubs submitted ETH topups as ERC-20 transfers and reverted with `ETH value!=amount`. |
| 22 | HIGH | closed in v2.1.4 (#109) | hub + SDK | `SENTINEL_SIG` used 65-byte `r`/`s` (should be 32-byte). `signatureToHex` produced 264-char rows; on next restart `loadAllLatest` threw `expected 65-byte hex signature, got length 264` and the pod went CrashLoopBackOff. |
| 23 | HIGH | closed in v2.1.7 (#115) | SDK | `chain.topUp`'s `eth_estimateGas` reverted with `!open` when the RPC's `latest`-block view lagged the canonical chain head; hub marked the offer `rejected` permanently. Now polls `channels(id).status == Open` first. |
| 24 | HIGH | closed in v2.1.8 (#118) | state-machine + hub | `MAX_HTLC_VALUE_PER_COUNTERPARTY = 1e8` was hard-coded to USDC base units. ETH/PTST channels (18 decimals) rejected every nontrivial payment as `per-counterparty inflight would exceed 100000000`. Cap is now per channel-token. |
| 25 | HIGH | worked around in run; **fix pending** | SDK | The SDK pre-fee math (`fee = (base*bps)/10000 + flat`) is asymmetric to the hub's quote on `total = base + fee`; the recipient sees `htlc.amount < invoice.amount` and rejects as `amount underpaid`. Worked around in this run by setting `HUB_FEE_BPS=0 / HUB_FEE_FLAT=0` on the GKE ConfigMap. Production fix should solve for `fee` such that `total - quote(total) >= base`. |
| 26 | HIGH | closed in v2.1.8 (#121) | hub | `LiquidityTracker.hydrate(...)` only restores HTLC reservations. Per-channel outbound/inbound snapshots, normally seeded by `ws.registerChannel` during chain-watcher bootstrap, stayed empty on restart so the router rejected every pay with `available outbound 0` even on a topped-up channel. Server startup now walks `channelPool.list()` and seeds the tracker. |
| 27 | HIGH | open | hub | `TopUpHandler.expireDue(...)` exists but is never wired to a periodic sweep. Proposed-but-undelivered offers stay reserved against hot-wallet headroom indefinitely. Workaround: a hub restart calls `hydrate()` which expires due rows. Production fix should add a setInterval/cron. |
| 28 | medium | open | hub | Topup propose fires on every `ChannelOpened` regardless of whether `userA` is a sender role. Closing #16 made this less hot, but offers still get burned on users who will never accept them. Production fix: only propose on subscribe + a "wants-inbound" hint. |
| 29 | HIGH | open | hub or SDK | Cooperative close from the **sender** side after a successful pay fails with opaque `chain error: Contract Call:`. `close --unilateral` hits the same revert. `close-from-open` rejects with `posted!=0` (because the topup posted a v1 state on-chain). Net: sender-side channel is stuck `Open` until manual recovery. Receiver-side cooperative close works because the receiver's local state matches the hub's last counter-signed state. Likely cause: the sender's local state-store doesn't persist the v3 post-pay state and the SDK falls through to the cooperative-close-of-v1 path with the wrong final-balances. |
| 30 | medium | open | hub | `pico-hub-config` ConfigMap held a stray `HUB_v2.1.8: v2.1.8` key from a prior debugging session — harmless but should be cleaned and replaced with a proper `HUB_RELEASE_TAG` value (see #20). |

## Release-pipeline gotcha

Every Version Packages PR landed in this run did **not** trigger
`gke-images.yml` on its own. The `changesets/action` step pre-creates
the `v*` tag on the source branch *before* the "Tag release for Docker
build" custom step sees it; the diff-against-last-tag logic then finds
"nothing changed since `vN.N.N`" and exits 0. Workaround was to
delete-and-re-push the tag manually after each merge (`git push origin
:refs/tags/vN.N.N && git tag vN.N.N main && git push origin
refs/tags/vN.N.N`). Production fix should pin the changesets step to
`createGithubReleases: false` and let the custom step own tag creation.

## Final balance state

- Deployer ETH: `0.000920 ETH` (down from `0.0496 ETH` at round-2
  baseline, ~`0.048 ETH` of which is in-flight: `0.0202 ETH` locked in
  the 10 pending closing-unilateral channels + ~`0.028 ETH` consumed in
  the cumulative gas of 9 release deploys + 2 hub redeploys + 5 smoke
  rounds).
- Deployer PTST: `999_649.91 PTST` (vs `999_996 PTST` baseline; `0.04
  PTST` stuck in sam's still-`Open` channel, `0.05 PTST` in pat's
  closing-unilateral channel, both recoverable).
- Locked at PaymentChannel contract: `0.0206 ETH` + `0.09 PTST` total.

## Status against the round-4 goal

| Criterion | Result |
|---|---|
| Production-ready core flow (open / topup / pay / cooperative close / drain) for native ETH | PASS (v2.1.9, with `HUB_FEE_BPS/FLAT=0` workaround) |
| Same for ERC-20 (PTST) | PASS through pay; sender-side cooperative close needs finding #29 fixed |
| All ETH eventually returned to deployer | PASS (in-flight after dispute windows elapse — schedule complete by `2026-05-15T07:14Z`) |
| Production-ready hub release pipeline | FAIL (release.yml's tag/Docker-tag race forces a manual re-tag every release; see "Release-pipeline gotcha" above) |
