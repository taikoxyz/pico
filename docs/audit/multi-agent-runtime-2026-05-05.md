# Multi-agent runtime audit pass

Date: 2026-05-05
Scope: `apps/hub`, `apps/watchtower`, `packages/sdk`, and
`packages/state-machine`.
Status: repo-side fixes implemented; full model-specific audit set still pending.

## Findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| MAG-RT-001 | High | `htlcFail` could fail an inflight route without validating a recipient-signed outgoing fail state. | Fixed |
| MAG-RT-002 | Medium | `htlcSettle`/`htlcFail` dispatch did not bind signed envelopes to the expected route recipient. | Fixed |
| MAG-RT-003 | Low | `ChainEventWatcher.__forFlush()` remains public on the private watchtower package. | Deferred low |
| MAG-RT-004 | Medium | `docs/audit-status.md` was stale for WTW-005, WTW-006, WTW-013, F-10, and H-07 evidence. | Fixed |

## Verification focus

- `packages/state-machine/src/admit.ts` now exposes `admitHtlcFail`.
- Hub WS fail/settle paths validate route, recipient signer, signed state, and
  HTLC removal before consuming the route.
- Tests cover missing/unauthorized `htlcFail` state and state-machine fail
  admission.

This report is the in-repo multi-agent synthesis. The exact report set requested
by GitHub issue #34 still requires separate named model reports if that issue is
closed by checkbox.
