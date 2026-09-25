# Project status assessment — 2026-06-03

> Operator-facing snapshot of where pico stands: code maturity, what is
> actually deployed vs. current `main`, the state of on-chain assets, the
> open GitHub backlog, and a dependency-ordered action list. This is an
> assessment artifact, not a spec change. Authoritative sources it
> reconciles: `final_readiness_report.html`, `docs/launch-log.md`,
> issue #21, and the round-2/round-4 mainnet smoke logs.

## 1. What pico is

A 1-hop state-channel network for micro-payments on Taiko L2 (chain id
`167000`). v1 targets AI-agent payments via the `pico` CLI. Default asset is
**USDC** (`0x07d83526730c7438048D55A4fc0b850e2aaB6f0b`); ETH and
owner-allowlisted ERC-20s are also supported. Components: `cli`, `hub`,
`watchtower`, `contracts` (PaymentChannel + Adjudicator + HTLC, solc 0.8.26).

## 2. Code maturity — high; blockers are operational, not code

Per `final_readiness_report.html` (generated 2026-05-14, HEAD `cf0d0eb`, v2.1.9):

| Dimension | Readiness |
|---|---|
| Solidity contracts | 88% |
| Off-chain runtime (hub/watchtower/SDK) | 82% |
| Test coverage | 85% |
| Infra / GKE | 72% |
| Operational drills | 10% |
| External audit + PGP | 15% |
| Real-USDC mainnet validation | 25% |
| **Overall** | **58% — NO-GO for GA** |

All test suites pass; the v2.1 pull-pattern fix (U-01/U-02/U-03) is implemented
and tested. The NO-GO is driven entirely by operational and external gates
(audit, drills, key custody, real-money smoke), **not** by missing code or a
needed re-architecture. The report estimates ~4–8 weeks of audit + drill
execution to reach GO.

## 3. Deployed code vs. current `main` — NOT consistent

Live today: GKE cluster `pico-mainnet` (asia-southeast1) + Taiko mainnet. Two
real on-chain smokes ran: Round-2 (2026-05-13, partial) and Round-4
(2026-05-14, ETH lifecycle PASS at hub `v2.1.9`).

Three layers of drift:

1. **Smokes used ETH + PTST (a test ERC-20), never real USDC.**
   `docs/launch-log.md` → "Real-USDC mainnet smoke" = **PENDING**.
2. **The validated baseline is `cf0d0eb` (v2.1.9); current HEAD is `76eb6f9`.**
   Eight commits merged since have never been validated on mainnet: peer
   channels (#154), idle channel auto-close (#153), Docker/CI fixes
   (#160/#161/#162), Version Packages (#151).
3. **The v2.1 pull-pattern contracts (#140 = `cf0d0eb`) were never deployed or
   smoked on mainnet.** The live contracts are still the older **push-pattern**,
   where a Circle blocklist on the hub hot wallet freezes all USDC settlement
   (`COMPLIANCE.md`, findings U-01/U-02). Pull-pattern removes that chokepoint.

**Consequence:** funding real USDC now would put it into a blocklist-exposed
older contract. Pull-pattern contracts + latest hub image must be deployed and
smoked first.

## 4. On-chain asset state

- **No real USDC has been deposited or validated on mainnet** (launch-log
  PENDING).
- Only real asset touched: **4 PTST (test token) locked in `ClosingUnilateral`
  channels** from Round-2, recoverable via `finalize` after 2026-05-14.
  **Open question: confirm whether these were recovered.**
- Deployer EOA `0x327fa3…` still holds proxy ownership; balance not yet swept.

## 5. The "few thousand USDC" task

Maps to issues **#49 / #148** (real-USDC mainnet smoke + hub liquidity funding).
Two caveats:

- **Amount mismatch:** #49 caps it at **100 USDC per channel / 1000 USDC hub
  ceiling**. "A few thousand" exceeds the current 1000 USDC ceiling — either
  raise the ceiling (config change + your call) or run the first validation at
  the conservative 1000 USDC.
- **Hard prerequisites:** cannot be done directly — depends on Phase A + B below.

## 6. GitHub backlog

**26 open issues**, anchored by master tracker **#21**. GA blockers:

| Issue | Item | Type |
|---|---|---|
| #145 | External audit sign-off (release embargo) | external |
| #146 | PGP key still placeholder | ops |
| #147 | Transfer proxy ownership → Timelock + Safe | on-chain/human |
| #148 / #49 | Real-USDC mainnet smoke | on-chain/human |
| #149 | Restore / paging / security drills | ops |
| #150 | Cloud Armor / Alertmanager / cosign+BinAuthz / HSTS | ops |
| #35 | Revoke + cold-store deployer key | on-chain/human |

**#21 is stale (written 2026-05-02).** Of its 6 "newly discovered gaps", 4 are
already fixed in current code: watchtower `fly.toml` now has a litestream
sidecar; Fly hub litestream retention is now 720h (30d); CI gate `needs` now
includes `e2e-fork`. Remaining: single CODEOWNER (`@dantaik`) bus-factor, and
verify the `__forFlush()` test-only export annotation. #21's percentages should
be revised upward.

**4 open PRs:** #168 (viem bump), #167 (ws bump — fixes a remote
memory-exhaustion DoS, merge soon), #166 (dev-deps group with major jumps —
TypeScript 6 / vitest 4 / biome 2, hold), and #152 (human PR fixing the PGP
placeholder, opened from a fork's `main`, ~19 days stale, needs review).

## 7. Action list (dependency-ordered)

`[you]` = operator/on-chain/key custody only; `[me]` = code/config/docs I can do.

### Phase 0 — immediate cleanup (low risk)
- `[me]` Merge PR #167 (ws DoS patch).
- `[you/me]` Confirm the 4 Round-2 PTST were `finalize`d; recover if not.
- `[me]` Update issue #21: mark the 4 fixed gaps done, refresh readiness numbers.
- `[me]` Review PR #152 (PGP); rebase-merge or open a clean replacement.

### Phase A — governance & keys (you; on-chain + cold wallet)
- Deploy v2.1 pull-pattern contracts to mainnet (`DeployProxies.s.sol`) — the
  prerequisite for safe USDC.
- Deploy TimelockController (48h) + Safe multisig; transfer proxy ownership off
  the deployer EOA (#147).
- Sweep + cold-store/destroy the deployer key (#35); record owner address, tx
  hashes, UTC time in `docs/launch-log.md`.

### Phase B — redeploy & validate latest code (mixed)
- `[me]` Build/tag current-`main` hub + watchtower images, push to Artifact
  Registry, update K8s manifests (remove placeholders).
- `[you+me]` Re-run mainnet smoke covering the new code (pull-pattern close,
  peer channels #154, idle auto-close #153).
- `[you]` Run the real-USDC full-lifecycle smoke (open → topUp → pay →
  cooperative close → unilateral close → finalize) at conservative caps (#49/#148).

### Phase C — fund USDC (you; depends on A + B)
- Decide the amount: conservative 1000 USDC vs. "a few thousand" (raising the
  hub liquidity ceiling is a config change I can make).
- Fund watchtower wallet with ETH (gas), hub with USDC up to the ceiling,
  operator wallets with 100 USDC + ~0.005 ETH each.

### Phase D — operations & external gates (GA-blocking; mostly you)
- `[you]` Engage an external auditor (#145, the release embargo gate).
- `[you/me]` Publish the real PGP key + run the security-disclosure drill
  (#146/#52/#50).
- `[you/me]` Run restore + paging drills (#149/#41); fill Alertmanager webhooks,
  Cloud Armor, cosign (#150).
- `[you/me]` Add a second CODEOWNER / on-call (#51 — the remaining #21 gap).

## Bottom line

Code is mature (58%; the NO-GO is audit/drills/real-money validation, not bugs).
The live deployment lags `main` and has never run real USDC, so funding USDC
cannot be done directly — Phase A (deploy pull-pattern + transfer ownership) and
Phase B (redeploy latest images + smoke) must come first, or the money lands in
a blocklist-exposed older contract. The "few thousand" figure also exceeds the
current 1000 USDC design ceiling, so the amount needs a decision before funding.
