# Round-4 mainnet smoke — ETH + PTST lifecycle

| Field | Value |
|---|---|
| Date (UTC) | 2026-05-14 |
| Operator | Daniel Wang (`dong77@gmail.com`) |
| Branch / HEAD | `dantaik/round-4-hub-topup-and-dispute-fix` (initial run was on `main` at `d8069fd`) |
| Target release | `v2.1.2` (initial), `v2.1.3` (re-run after fix) |
| Network | Taiko mainnet (chain id `167000`) |
| RPC | `https://rpc.mainnet.taiko.xyz` |
| Hub | `https://hub.pico.taiko.xyz` (hub address `0x2d8Bac9eC662F7F09E59296f43B59D21EF6E9cc9`) |
| PaymentChannel | `0xA2665f2Fdf23CAA362b63F7A8902466f0504332d` |
| Adjudicator | `0x8C913a936F99e93e298f7800f14C46C32D71e26B` |
| PTST | `0x3CF2321323C23c9F91daFe99E2b121cab5cE3759` |
| Deployer | `0x327fa3369B1D1D42120d84bc407e5865ECa7c458` |

## Pre-flight changes

| Change | Value | Tx |
|---|---|---|
| `setMinChannelAmount(0x0, 1e14)` | 0.01 ETH → 0.0001 ETH per-channel floor on native ETH | [`0x5b100ccee8a1af636b18a334fb1649ed6c4dde9c12eda4b08e8d84237e4c812d`](https://taikoscan.io/tx/0x5b100ccee8a1af636b18a334fb1649ed6c4dde9c12eda4b08e8d84237e4c812d) |
| `v2.1.2` GKE re-deploy | `release.yml` skipped `gke-images.yml` because changesets/action pre-created the tag (release-pipeline ordering bug, not closed by round-3 finding #12 fix). Re-pushed the tag manually to fire the deploy. | gke-images run [25841547858](https://github.com/taikoxyz/pico/actions/runs/25841547858) (build + apply manifests) |

## Wallets

| Role | Address | Encrypted key |
|---|---|---|
| henry | `0x07a9b10f947c8e37350b640A9AD1619750B70807` | `~/.pico/henry/key.enc` |
| ivy | `0xE10baE2111A1bd242C1E41C93917977c0eBfA166` | `~/.pico/ivy/key.enc` |

Passphrases recorded in gitignored `.context/round-4-secrets.env` (mode 0600).

## Initial round (v2.1.2) — Phase C native-ETH lifecycle

Plan, executed inline (no script):
1. Fund henry + ivy (0.00015 ETH each) from deployer.
2. Open native-ETH channels (amount 0.0001 ETH = the new contract floor) for both.
3. Start `pico listen` on ivy; ivy creates a 1e13-wei (0.00001 ETH) invoice.
4. henry pays.
5. Cooperative close both.
6. Drain residuals to deployer.

### B — funding

| Action | Tx |
|---|---|
| Fund 0.00015 ETH → henry | [`0x964271dc5b9862cbd74f4bde99ecca70a8d1ca13a4c8771606f1d03d7c698c48`](https://taikoscan.io/tx/0x964271dc5b9862cbd74f4bde99ecca70a8d1ca13a4c8771606f1d03d7c698c48) |
| Fund 0.00015 ETH → ivy | [`0x90d562e4071517d94df4d6e80b9f0bd9320e7da5aa24f78ec87a0a54d0a65aa9`](https://taikoscan.io/tx/0x90d562e4071517d94df4d6e80b9f0bd9320e7da5aa24f78ec87a0a54d0a65aa9) |

### C.1 — channel opens (PASS on-chain, subscribe race tolerated)

| Role | channelId | Open tx | amountA |
|---|---|---|---|
| henry | `0x556b18d59dcff4b4c659269d64d3d8cd94064135c049c69cef7ba7bfe54333d1` | [`0x16466ed7…`](https://taikoscan.io/tx/0x16466ed7dc1f6676bdabed969d5e036d20880397ec6ad42f432de9201dab8182) | 0.0001 ETH |
| ivy | `0xb517e452d674507b6bd547e9bc7d3e3f53fbba6762cc2c691f54dead7a27eccf` | [`0xb277103b…`](https://taikoscan.io/tx/0xb277103bd0f1106fa98aa589d9b98643993f64493612ede636b62cd06e0a6d1f) | 0.0001 ETH |

Both opens emitted `ChannelOpened`; PR #99 (CLI/SDK native-ETH) and PR #102 (chain-watcher bootstrap) work end-to-end on the open path. Both CLI invocations exited 0 with `warning: hub subscribe failed; channel is on-chain and persisted locally` — round-3 finding #7 fix (post-open subscribe race tolerated) works as designed.

Hub log on each open:
- `channel registered`
- `channel bootstrapped from chain` (PR #102 fix)
- `topup: proposed offerId=… amount=50000000000000000 delivered=false` (henry's open; 0.05 ETH offer to userA)
- `topup: queuing — admission policy rejected` reason `hot-wallet headroom exhausted` (ivy's open)

### C.2 — pay (BLOCKED by §8 inbound-liquidity gap; new HIGH findings)

```
$ pico invoice create --amount 10000000000000  # 0.00001 ETH
$ pico pay --invoice <env>
{"stage":"verifying"}
payment failed: router: hub liquidity 0 < outgoing amount 9999999600000 on 0xb517e452…
```

Three HIGH findings (new in round-4 — not surfaced in round-3 because that round was already blocked earlier in the topup propose path):

| # | Severity | Component | Finding |
|---|---|---|---|
| 16 | **HIGH** | hub | `defaultOfferAmount[ETH] = 0.05 ETH` is wildly oversized for the hub's `0.05 ETH` hot wallet. The first channel opener gets a `0.05 ETH` propose; the *next* channel gets `hot-wallet headroom exhausted`. Effectively the hub can only service one inbound counterparty until that offer expires (or never, see #18). |
| 17 | **HIGH** | hub | The hub proposes top-up to every fresh `ChannelOpened` it bootstraps, even when the channel's `userA` is the channel opener / sender role — i.e., the user with no need for inbound liquidity. Wasting the offer on a sender starves the eventual receiver. |
| 18 | **HIGH** | hub | `TopUpHandler.expireDue(nowMs)` exists but is never wired to a periodic sweep in `server.ts`. Proposed but-not-delivered offers stay reserved against hot-wallet headroom forever, so headroom never recovers automatically. |

(Findings #16/#17/#18 collectively make the §8 path broken for native ETH at the current production hot-wallet sizing.)

The pay attempt also exposed two further issues:

| # | Severity | Component | Finding |
|---|---|---|---|
| 19 | **HIGH** | hub | dispute-handler spams `dispute(channelId, state, sigA, sigB)` retries on every chain-watcher poll for any channel in `ClosingUnilateral` that the bootstrap path registered with a sentinel-signed v0 state. The submitted `sigA`/`sigB` are zeros and the contract reverts with `bad sig` every time. With four legacy ClosingUnilateral channels in the pool, the hub generated dozens of reverted-tx errors per minute. |
| 20 | medium | hub | `/v1/health.version` still reports `0.0.0` (round-3 finding #3 untouched). Round-3 v2.1.2 release notes mention a fix but `HUB_RELEASE_TAG` is not set in the GKE StatefulSet's env. |

### C.3 — close (PASS via close-from-open; cooperative still broken)

`pico channel close <id>` (cooperative default) surfaced `chain error: Contract Call:` with no detail (round-3 finding #14 — auto-route to close-from-open — not actually fixed). Manual `pico channel close-from-open` worked first try for both:

| Role | Close tx | disputeDeadline |
|---|---|---|
| henry | [`0xe7d69a6c…`](https://taikoscan.io/tx/0xe7d69a6c12062aa923a1d1627dfcd95a7e370724770aabe6a0604e6f3bc4325c) | 2026-05-15T04:40:55Z |
| ivy | (recovered via on-chain channel-state read) | 2026-05-15T04:45:59Z |

(Both 0.0001 ETH are now locked in `ClosingUnilateral` for 24 h.)

The CLI hung in the `--json` path after submitting the on-chain tx (waiting on a hub WS confirmation that never arrives because §8 routing is broken — see #17). Killing the CLI did not affect the on-chain state.

### Phase D — drain residuals (PASS, manual)

`pico keys drain` again refused on near-empty wallets (round-3 finding #4 not fully fixed; same `total cost ... exceeds the balance of the account` shape). Drained manually with `cast send` using explicit `--gas-price 4×eth_gasPrice` and `--gas-limit 21000`:

| Role | Drain tx |
|---|---|
| henry | [`0xad2fbcdd…`](https://taikoscan.io/tx/0xad2fbcddc93609a1d6b399cb7a0c057f16dadc52ba32ee01d76fcffc08ce8482) |
| ivy | [`0x24ab9211…`](https://taikoscan.io/tx/0x24ab92116ddc87330c61265942ec45e51f412902967991188367ee96142dc9ea) |

## Initial-round result

| Phase | Result |
|---|---|
| 0 — v2.1.2 deploy gate | PASS (after manual tag re-push due to release-pipeline race) |
| Pre-flight — `setMinChannelAmount(0x0, 1e14)` | PASS |
| B — funding | PASS |
| C.1 — native-ETH channel open | PASS |
| C.2 — pay flow | **BLOCKED** (3 HIGH hub findings: #16/#17/#18; #19 also surfaced) |
| C.3 — close | PASS (via `close-from-open`; cooperative still opaque-errors) |
| D — drain | PASS (manual) |

## Patch + re-run (PR #106 → v2.1.3)

PR [#106](https://github.com/taikoxyz/pico/pull/106) — `fix(hub): lower ETH topup default; skip dispute on sentinel sigs`:

1. `apps/hub/src/topup-policy.ts` — `defaultOfferAmount[ETH]` from `5e16` → `1e14` (closes #16 — hot wallet now services ~500 channels at default sizing).
2. `apps/hub/src/dispute-handler.ts` — refuse to submit any state whose `sigA`/`sigB` is a sentinel `r=s=0` (closes #19).

(_#17 and #18 deliberately left for a follow-up; they are not strict blockers once the offer size is sized correctly._)

_TBD: re-run Phase C with the patched build (v2.1.3), then run an analogous ERC-20 (PTST) lifecycle, then sweep residuals back to deployer._
