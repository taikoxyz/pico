# Concise readiness summary

## Judge verdict

Opus is the better decision memo: clearer structure, cleaner blocker list, and
less historical detail. DeepSeek is useful as the evidence appendix because it
captures more audit reconciliation context, but it is too long for an executive
readiness call and mixes fixed items into the blocker narrative.

Both reports agree on the important conclusion: **not ready for production
mainnet custody of real USDC; roughly 40% ready.**

## Current state

The repo has absorbed much of the DeepSeek audit work. CI, fork e2e, SDK state
admission, hub safety gates, and most contract/hub/watchtower fixes are in
place. The four code-only audit items that were still open at the time of the
last readiness pass — WTW-005, WTW-006, F-10, and WTW-013 — have now been
closed in code (PR `dantaik/wt-audit-fixes`); they await re-audit before being
re-categorized in `docs/audit-status.md`. Audit status is:

| Status | Count |
|---|---:|
| Fixed | 36 |
| Patched-not-reaudited (incl. 4 just-landed code fixes) | 18 |
| Open | 2 |
| Total | 56 |

## Mainnet blockers

- UUPS proxies are still owned by the deployer EOA; timelock ownership transfer
  has not been executed.
- No independent human audit firm has signed off on the patched contracts.
- No real-USDC Taiko mainnet smoke channel has been run.
- Hub-advertised fee policy (H-10) and full liquidity-from-states (H-11) are
  patched but not fully implemented.
- Runbooks are written but not drilled; several still carry draft markers.
- Security disclosure is incomplete: placeholder PGP key and unmonitored inbox.

### Recently closed (in code, pending re-audit)

- **WTW-005**: `remember()` now validates SignedState before storing —
  EIP-712 sigA/sigB against on-chain `userA`/`userB`, empty HTLCs, balance
  conservation against on-chain funding, `finalized=false`. Channel
  invariants cached after first chain read.
- **WTW-006**: live close-event handler now records observation but defers
  submission to scheduler when `Date.now() < submitByMs`, so the configured
  `PENALTY_THRESHOLD` is honored on every code path.
- **F-10**: SDK no longer exports `./signer.test-only` or `./_test`; the
  in-memory signer and mock hub/chain adapter live in `@tainnel/test-utils`.
  `npm pack` tarball verified clean of test-only paths and `src/`.
- **WTW-013**: `apps/watchtower/src/recovery.test.ts` adds 9 regression
  scenarios covering WTW-002 restart-then-submit, WTW-003 stale-tx
  replacement and same-nonce reuse across ticks, WTW-005 forged-sig /
  non-empty-htlcs / balance-mismatch / finalized rejections, WTW-006
  live-defer/scheduler-submit, and WTW-010 reverted-receipt handling.

## GKE blockers

GKE manifests are well-structured but unproven. The main technical blocker is
that hub and watchtower bind `/metrics` to `127.0.0.1`, so Prometheus in another
pod cannot scrape them. Add a configurable metrics bind address before relying
on monitoring.

Other GKE gaps: no GKE deploy workflow, no tagged Artifact Registry images, no
created cluster confirmed, placeholder Alertmanager webhooks, and no paging or
restore drill.

## Recommended next work

1. Fix the metrics binding (`METRICS_BIND_ADDR`) so Prometheus can scrape hub
   and watchtower in GKE.
2. Start external audit engagement in parallel — the patched-not-reaudited set
   is now larger (18 items) and includes the four just-landed watchtower / SDK
   fixes.
3. Deploy timelock, transfer proxy ownership, and cold-store the deployer key.
4. Build/tag images, deploy GKE, replace placeholders, and verify monitoring,
   paging, Litestream, and restore.
5. Publish real PGP/security contact, finalize runbooks, run drills, then run
   the real-USDC mainnet smoke channel.

## Bottom line

Use Opus as the base summary and DeepSeek as supporting evidence. The project
has made strong engineering progress, but it is not ready to custody real funds
until governance, audit, watchtower correctness, monitoring, security disclosure,
and operational drills are complete.
