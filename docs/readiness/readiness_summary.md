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
place. Audit status is:

| Status | Count |
|---|---:|
| Fixed | 36 |
| Patched-not-reaudited | 14 |
| Open | 6 |
| Total | 56 |

## Mainnet blockers

- UUPS proxies are still owned by the deployer EOA; timelock ownership transfer
  has not been executed.
- No independent human audit firm has signed off on the patched contracts.
- No real-USDC Taiko mainnet smoke channel has been run.
- Watchtower still has two important open issues: WTW-005 signature validation
  in `remember()` and WTW-006 penalty threshold bypass in the live path.
- F-10 and WTW-013 remain open: public test-only SDK exports and incomplete
  watchtower recovery tests.
- Runbooks are written but not drilled; several still carry draft markers.
- Security disclosure is incomplete: placeholder PGP key and unmonitored inbox.

## GKE blockers

GKE manifests are well-structured but unproven. The main technical blocker is
that hub and watchtower bind `/metrics` to `127.0.0.1`, so Prometheus in another
pod cannot scrape them. Add a configurable metrics bind address before relying
on monitoring.

Other GKE gaps: no GKE deploy workflow, no tagged Artifact Registry images, no
created cluster confirmed, placeholder Alertmanager webhooks, and no paging or
restore drill.

## Recommended next work

1. Fix WTW-005, WTW-006, F-10, watchtower recovery tests, and metrics binding.
2. Start external audit engagement in parallel.
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
