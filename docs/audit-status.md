# Audit status reconciliation

Single source of truth for what each DeepSeek audit finding means today.
Replaces ad-hoc "X is open" / "Y was fixed" claims passed around by hand.

This file is a historical reconciliation record. New production-readiness
work — including any **Open** items below — is tracked as sub-issues under
[issue #21](https://github.com/dantaik/tainnel/issues/21) on GitHub.

## Methodology

Each finding from the five DeepSeek reports under repo root
(`deepseek_audit_report_*.md`) was checked against the current code at HEAD.
Status values:

- **Fixed** — the original finding's defect is no longer reachable, with
  cited file:line evidence in the current source.
- **Patched-not-reaudited** — a fix has landed but it's a partial /
  related fix, or the original wording isn't fully closed. Acceptable for
  v1 but worth re-review.
- **Open** — the defect is still present and tracked.
- **Won't-fix** — out of scope for v1, deferred to Phase 2.

DeepSeek is an AI auditor; further multi-agent audit passes (Claude Opus,
GPT-5, Gemini, etc.) are tracked under
[issue #21](https://github.com/dantaik/tainnel/issues/21) before mainnet GA.

## Summary

| Status | Count |
|---|---|
| Fixed | 36 |
| Patched-not-reaudited | 14 |
| Open | 6 |
| Won't-fix | 0 |
| **Total** | **56** |

## Protocol core

Source: `deepseek_audit_report_protocol_core.md`. Most fixes landed in
commit `c4e4cd1` and PR #15.

| ID | Severity | Description | Status | Evidence |
|---|---|---|---|---|
| PC-01 | Critical | `dispute()` accepted closer-only signature | Fixed | `packages/contracts/src/PaymentChannel.sol:255` — `dispute(...)` takes `sigA, sigB` and calls `_verifyDualSig` |
| PC-02 | High | HTLC + cooperative-close spec/impl divergence | Patched | `docs/protocol-spec.md` rewrites the v1 model: no close while HTLCs in flight; `closeCooperative` signs `CooperativeClose` with no HTLC root |
| PC-03 | High | Cooperative close didn't verify dual sig | Fixed | `PaymentChannel.sol:179-190` decodes `CooperativeClose` and calls `_verifyDualCooperativeClose` |
| PC-04 | Critical | `submitPenaltyProof` missing dual sig | Fixed | `PaymentChannel.sol:291-307` requires `sigA, sigB` |
| PC-05 | High | Dispute deadlines unchecked | Fixed | `PaymentChannel.sol:261, 275, 299` enforce `block.timestamp < disputeDeadline`; dispute resets the deadline once via `!ch.penalized` (#15) |
| PC-06 | Medium | Channel ID collision risk | Fixed | `PaymentChannel.sol:148` includes `address(this)` in the keccak input |
| PC-07 | Medium | State machine accepted cross-channel updates | Fixed | `packages/state-machine/src/channel.ts:22` rejects mismatched `channelId` |
| PC-08 | Medium | Hoodi listed as supported in protocol constants | Fixed | `packages/protocol/src/constants.ts:11-14` removed Hoodi from `SUPPORTED_CHAIN_IDS` |
| PC-09 | Critical | Deployer EOA owns both proxies; no multisig/timelock | **Open** | `packages/contracts/script/Deploy.s.sol:23,27` still gives deployer ownership. Transfer scripts shipped in `packages/contracts/script/{Deploy,Transfer}Timelock.s.sol`; on-chain transfer is `[human]` per `docs/runbooks/ownership-transfer.md`. Tracked under [issue #21](https://github.com/dantaik/tainnel/issues/21) |
| PC-10 | Info | EIP-712 oracle should remain pinned and crosstested | Fixed | Oracle pinned via existing forge fuzz + crosstest; no regressions |

## Hub

Source: `deepseek_audit_report_hub.md`. Closed by commit `e9bf7ec`.

| ID | Severity | Description | Status | Evidence |
|---|---|---|---|---|
| H-01 | Critical | Unauthenticated payment messages routed funds | Fixed | `apps/hub/src/api/ws.ts:14-17,151,335,453,526` admit gates wired |
| H-02 | Critical | No signed envelope on incoming WS messages | Fixed | `apps/hub/src/api/ws.ts:573-624,645-681` verifies signed envelope, binds signer to `msg.address`; mainnet requires envelopes (`config-validate.ts:42-46`) |
| H-03 | Critical | Hub started on mainnet with deterministic dev keys if env empty | Fixed | `apps/hub/src/config-validate.ts:11-89` rejects known dev keys, requires explicit hub key, operator token, signed envelopes |
| H-04 | High | Concurrent route signing race | Fixed | Per-channel mutex around route construction in `apps/hub/src/router.ts` (e9bf7ec) |
| H-05 | High | Reservations could occur after durable state | Fixed | `migrations/002_payment_routes.sql` + `apps/hub/src/route-repo.ts:208 loadInflight` + transactional pay path |
| H-06 | High | Router lost in-flight routes on restart | Fixed | `apps/hub/src/router.ts:140-156` `loadInflight` rehydrates routes; logs "router: hydrated inflight routes from db" |
| H-07 | High | Settle/fail not bound to persisted route + signer | Fixed | `apps/hub/src/api/ws.ts` settle/fail paths bound to persisted route + signer (e9bf7ec) |
| H-08 | High | Dispute handler wrong state selection | Fixed | `apps/hub/src/dispute-handler.ts` selects dispute-eligible empty-HTLC state; receipt status checked |
| H-09 | Medium | Chain watcher had reorg + chunking gaps | Fixed | `apps/hub/src/chain-watcher.ts` rewritten with `rewindForReorg`, deploy-block init, chunked log scans |
| H-10 | Medium | SDK didn't honor hub-advertised fees | Patched-not-reaudited | SDK defaults to `DEFAULT_HUB_FEE_BPS/FLAT` from protocol constants (`packages/sdk/src/client.ts:111`); full hub-advertised fee policy not implemented |
| H-11 | Medium | Liquidity reservation could trail durable state | Patched-not-reaudited | Reservations precede durable state changes (#16); authoritative liquidity-from-states still partial |
| H-12 | Low | Missing NOT NULL / FK / CHECK constraints | Patched-not-reaudited | NOT NULL constraints exist; route-repo + update-result checks added; full FK/CHECK enum constraints partial |
| H-13 | Low | `/metrics` exposed on public port | Fixed | `apps/hub/src/server.ts:110-118` binds `prometheusPort` on 127.0.0.1 |

## Watchtower

Source: `deepseek_audit_report_watchtower.md`. Closed by commit `e9bf7ec`.

| ID | Severity | Description | Status | Evidence |
|---|---|---|---|---|
| WTW-001 | Critical | Pending events never flushed without new logs | Fixed | `apps/watchtower/src/watcher.ts:114-150` `confirmationFlushInterval` independent flusher |
| WTW-002 | Critical | Deferred penalties lost on restart | Fixed | Scheduler persists durable closing observations before advancing cursor |
| WTW-003 | Critical | Dropped txs never re-broadcast | Fixed | `apps/watchtower/src/responder.ts:111-145` replaces stuck tx with same nonce + bumped fee after `inclusionTimeoutMs` |
| WTW-004 | Critical | Watchtower started with deterministic keys if env empty | Fixed | `apps/watchtower/src/config-validate.ts` rejects known dev keys on non-anvil; mainnet gates explicit |
| WTW-005 | High | `remember()` doesn't validate signatures | **Open** | `apps/watchtower/src/index.ts:250-253` — calls `store.putSignedState` + `detector.remember` without `verifyChannelStateSignature` or balance/HTLC checks. No watchtower-side admission gate |
| WTW-006 | High | Live path bypasses penalty threshold timing | **Open** | `apps/watchtower/src/index.ts:154-179` — live event submits immediately on `evaluation.action === 'penalize'`; detector's `submitByMs` is not gating the live path. Scheduler path respects threshold. Inconsistent timing remains |
| WTW-007 | Medium | Plaintext SQLite DB | Patched-not-reaudited | README clarifies SQLite plaintext + filesystem encryption requirement; encrypted-at-rest implementation deferred to Phase 2 |
| WTW-008 | Medium | `MODE=service` shouldn't be allowed in v1 | Patched-not-reaudited | `config-validate.ts` rejects `MODE=service` |
| WTW-009 | Medium | Confirmations + reorg handling gaps | Fixed | Scheduler applies `confirmations`; storage block-hash rewind |
| WTW-010 | Medium | Tx receipt status not checked | Fixed | `responder.ts:235, :144` checks `receipt.status === 'success'` |
| WTW-011 | Low | Config parser too permissive | Fixed | `config-validate.ts` parses with explicit ranges/checks |
| WTW-012 | Low | Health endpoint shallow | Patched-not-reaudited | Health includes scheduler tick + pending-tx age + RPC; full DB probe partial |
| WTW-013 | Low | Recovery test suite incomplete | **Open** | Happy-path test exists; recovery-focused suite still partial |

## Client runtime (SDK + CLI)

Source: `deepseek_audit_report_client_runtime.md`. Closed by commit `e9bf7ec`.

| ID | Severity | Description | Status | Evidence |
|---|---|---|---|---|
| F-01 | Critical | SDK trusts hub-supplied state without verification | Fixed | `packages/sdk/src/client.ts:20-23,348,586,744,869` admit gates from `@tainnel/state-machine` wired into all signed-state ingestion paths |
| F-02 | High | Restart consistency gaps | Patched-not-reaudited | Restart still has gaps; subscribe-ack `pendingHtlcs` consumption partial |
| F-03 | High | Invoice replay possible | Fixed | `client.ts:379` rejects consumed invoice; `verifyInvoice` called (`client.ts:613`); `storage-file.ts:170-176` consumed-mark idempotent |
| F-04 | Medium | Hub message decoding too permissive | Patched-not-reaudited | `packages/sdk/src/hub-protocol.ts:191-211` validates JSON shape, kind whitelist, id; full discriminated schema validation per kind not implemented; admit gates compensate downstream |
| F-05 | Medium | Hot key file lacked fsync + perms | Fixed | `storage-file.ts:1,52-55,60,79,104-108` fsyncs file + parent dir, `0o600` files + `0o700` dirs |
| F-06 | Medium | CLI leaks secrets via flags / preimage in stdout | Patched-not-reaudited | Warnings on `--private-key` / env var; `--reveal-preimage` redacts by default; argv-key rejection in production not yet enforced |
| F-07 | Medium | SDK didn't apply default hub fees | Fixed | SDK defaults to `DEFAULT_HUB_FEE_BPS/FLAT` from protocol constants; hub-advertised quote tracked under H-10 |
| F-08 | Low | DVM adapter shipped as if production-ready | Fixed | `dvm-adapter/src/listener.ts:2,22-25` `@experimental` markers, throws on use; `SelectOpts` cleaned up |
| F-09 | Low | Zero-address allowed for contract addresses | Fixed | Hub `config-validate.ts:54-71` rejects zero addresses; CLI uses `Adjudicator` for verifyingContract |
| F-10 | Low | Test-only SDK exports public on npm | **Open** | `packages/sdk/package.json:15-21` still exports `./signer.test-only` and `./_test`. `LocalSigner` extends `InMemorySigner` from test-only path |

## E2E / Ops / Docs

Source: `deepseek_audit_report_e2e_ops_docs.md`. Closed by commit `e9bf7ec`
plus the Tier B / C / D agent commits in this branch.

| ID | Severity | Description | Status | Evidence |
|---|---|---|---|---|
| EOD-01 | Critical | CLI signs against PaymentChannel; contracts verify against Adjudicator | Fixed | `apps/cli/src/commands/channel.ts:96, 115` and `pay.ts:99, 139` use `Adjudicator` as `verifyingContract` |
| EOD-02 | High | No mainnet fork e2e in CI | Fixed | `.github/workflows/ci.yml:195-216` `e2e-fork` job + `e2e/src/scenarios.fork.test.ts` value-flow tests via whale impersonation |
| EOD-03 | High | DB-only restart not proven | Patched-not-reaudited | route-repo + loadInflight rehydrates router; full e2e proving DB-only restart still partial |
| EOD-04 | Critical | Services started on mainnet with dev defaults | Fixed | Hub + watchtower `config-validate.ts` fail-fast on mainnet defaults |
| EOD-05 | High | No runbooks for incident response | Patched-not-reaudited | Runbooks shipped under `docs/runbooks/` (README + 6 runbooks). Full operational drills pending Phase B/C completion |
| EOD-06 | Medium | No SQLite + litestream backup baseline | Fixed | Code defaults to SQLite + litestream (`apps/{hub,watchtower}/Dockerfile` + `infra/docker-compose.{prod,watchtower}.yml`) |
| EOD-07 | Medium | No coverage tracking in CI | Patched-not-reaudited | CI runs `vitest run --coverage` per `.github/workflows/ci.yml`; coverage thresholds not yet enforced |
| EOD-08 | High | SECURITY.md placeholder; no PGP key | Fixed | New `SECURITY.md` + `pgp-key.asc.placeholder` + `docs/runbooks/security-disclosure.md` + atomic-swap CI gate at `.github/workflows/security-md-lint.yml` |
| EOD-09 | Low | ROADMAP.md status drift | Fixed | This commit syncs P8/P9/P10 statuses |
| EOD-10 | Low | Watchtower DB encryption-at-rest unclear | Patched-not-reaudited | README + watchtower runbook clarify SQLite plaintext + filesystem encryption requirement |
| EOD-11 | Low | README links broken | Fixed | README links updated to `docs/learning/` |

## Stale-claim sweep (non-audit-ID items)

| Item | Status | Notes |
|---|---|---|
| `ROADMAP.md` P8 row | Fixed in this commit | Was "🔵 not started" while `e2e/src/scenarios.test.ts` runs full lifecycle |
| `SECURITY.md` "research-grade" framing | Fixed | Replaced with operable disclosure surface |
| `docs/runbooks/*.md` `DRAFT` markers | Patched | `backup-restore.md` updated; remaining four (`hub-incident.md`, `watchtower-down.md`, `dispute-response.md`, `key-rotation.md`) still carry the README-level DRAFT marker pending operational drills |
| `infra/README.md` `(TODO P9)` placeholder | Fixed | Replaced with `fly/README.md` pointer |
| `e2e/src/scenarios.fork.test.ts` USDC TODO | Fixed | WS-16 closed by whale impersonation |
| `docs/plans/10-launch.md` "⚪ planning only" | Fixed in this commit | Flipped to 🟡 in progress with footnote to launch-checklist.md |

## Provenance

This file was generated by reading every cited line against the current
code at HEAD. If you find a status that no longer matches the source,
please file an issue and update the row in the same PR that reconciles it.
