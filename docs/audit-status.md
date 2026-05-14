# Audit status reconciliation

Single source of truth for what each DeepSeek audit finding means today.
Replaces ad-hoc "X is open" / "Y was fixed" claims passed around by hand.

This file is a historical reconciliation record. New production-readiness
work — including any **Open** items below — is tracked as sub-issues under
[issue #21](https://github.com/taikoxyz/pico/issues/21) on GitHub.

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
[issue #21](https://github.com/taikoxyz/pico/issues/21) before mainnet GA.

## Summary

| Status | Count |
|---|---|
| Fixed | 42 |
| Patched-not-reaudited | 16 |
| Open | 1 |
| Won't-fix | 0 |
| **Total** | **59** |

The single **Open** row is PC-09 (proxy ownership / multisig + timelock).
H-10 and H-11 (hub-advertised fee policy and authoritative liquidity from
states) land in **Patched-not-reaudited** above; both are tracked as
follow-ups under [issue #21](https://github.com/taikoxyz/pico/issues/21)
alongside PC-09, but they are not counted as Open because partial
remediations have shipped (see Evidence column for each row).

## Protocol core

Source: `deepseek_audit_report_protocol_core.md`. Most fixes landed in
commit `c4e4cd1` and PR #15.

| ID | Severity | Description | Status | Evidence |
|---|---|---|---|---|
| PC-01 | Critical | `dispute()` accepted closer-only signature | Fixed | `packages/contracts/src/PaymentChannel.sol:519,533` — `dispute(...)` takes `sigA, sigB` and calls `_verifyDualSig` |
| PC-02 | High | HTLC + cooperative-close spec/impl divergence | Resolved in v2 | v2 implements on-chain HTLC settlement: `claimHtlc`/`refundHtlc` settle each HTLC during the new `Status.ResolvingHtlcs` phase after a unilateral close. `closeCooperative` still requires zero in-flight HTLCs (and signs `CooperativeClose` with no HTLC root) since it's a single-shot path. See `docs/protocol-spec.md` §5.4 + `docs/release-notes-v2.md`. |
| PC-03 | High | Cooperative close didn't verify dual sig | Fixed | `PaymentChannel.sol:328,341` — `closeCooperative` decodes `CooperativeClose` and calls `_verifyDualCooperativeClose` |
| PC-04 | Critical | `submitPenaltyProof` missing dual sig | Fixed | `PaymentChannel.sol:558,574` — `submitPenaltyProof(...sigA, sigB)` and `_verifyDualSig` |
| PC-05 | High | Dispute deadlines unchecked | Fixed | `PaymentChannel.sol:525, 566, 603` enforce `block.timestamp < disputeDeadline` (`dispute`, `submitPenaltyProof`) and `>= disputeDeadline` (`finalize`); dispute resets the deadline once via `!ch.penalized` (#15) |
| PC-06 | Medium | Channel ID collision risk | Fixed | `PaymentChannel.sol:291` includes `address(this)` in the keccak input |
| PC-07 | Medium | State machine accepted cross-channel updates | Fixed | `packages/state-machine/src/channel.ts:22` rejects mismatched `channelId` |
| PC-08 | Medium | Hoodi listed as supported in protocol constants | Fixed | `packages/protocol/src/constants.ts:19-23` excludes `TAIKO_HOODI_CHAIN_ID` from `SUPPORTED_CHAIN_IDS` |
| PC-09 | Critical | Deployer EOA owns both proxies; no multisig/timelock | **Open** | Deploy/transfer scripts now require contract owners and 48h timelock checks (`packages/contracts/script/{Deploy,DeployTimelock,TransferOwnership}.s.sol`), but on-chain owner-code/key-custody evidence is still an operator gate tracked under [issue #21](https://github.com/taikoxyz/pico/issues/21) and #35 |
| PC-10 | Info | EIP-712 oracle should remain pinned and crosstested | Fixed | Oracle pinned via existing forge fuzz + crosstest; no regressions |

## Hub

Source: `deepseek_audit_report_hub.md`. Closed by commit `e9bf7ec`.

| ID | Severity | Description | Status | Evidence |
|---|---|---|---|---|
| H-01 | Critical | Unauthenticated payment messages routed funds | Fixed | `apps/hub/src/api/ws.ts:20` imports `admitSignedState` from state-machine; admit gate invoked at `:594` and other ingestion paths |
| H-02 | Critical | No signed envelope on incoming WS messages | Fixed | `apps/hub/src/api/ws.ts:26,848-864` verifies signed envelope via `verifyEnvelope`, binds signer; mainnet requires envelopes (`config-validate.ts`) |
| H-03 | Critical | Hub started on mainnet with deterministic dev keys if env empty | Fixed | `apps/hub/src/config-validate.ts` rejects known dev keys, requires explicit hub key, operator token, signed envelopes |
| H-04 | High | Concurrent route signing race | Fixed | Per-channel mutex around route construction in `apps/hub/src/router.ts` (e9bf7ec) |
| H-05 | High | Reservations could occur after durable state | Fixed | `migrations/002_payment_routes.sql` + `apps/hub/src/db/repos/route-repo.ts:213 loadInflight` + transactional pay path |
| H-06 | High | Router lost in-flight routes on restart | Fixed | `apps/hub/src/router.ts:178,194` `loadInflight` rehydrates routes; logs "router: hydrated inflight routes from db" |
| H-07 | High | Settle/fail not bound to persisted route + signer | Fixed | `apps/hub/src/api/ws.ts` validates settle/fail against the persisted route, expected recipient signer, recipient-signed outgoing state, and route HTLC id/payment hash |
| H-08 | High | Dispute handler wrong state selection | Fixed | `apps/hub/src/dispute-handler.ts` selects dispute-eligible empty-HTLC state; receipt status checked |
| H-09 | Medium | Chain watcher had reorg + chunking gaps | Fixed | `apps/hub/src/chain-watcher.ts` rewritten with `rewindForReorg`, deploy-block init, chunked log scans |
| H-10 | Medium | SDK didn't honor hub-advertised fees | Patched-not-reaudited | SDK defaults to `DEFAULT_HUB_FEE_BPS/FLAT` from protocol constants (`packages/sdk/src/client.ts:111`); full hub-advertised fee policy not implemented |
| H-11 | Medium | Liquidity reservation could trail durable state | Patched-not-reaudited | Reservations precede durable state changes (#16); authoritative liquidity-from-states still partial |
| H-12 | Low | Missing NOT NULL / FK / CHECK constraints | Patched-not-reaudited | NOT NULL constraints exist; route-repo + update-result checks added; full FK/CHECK enum constraints partial |
| H-13 | Low | `/metrics` exposed on public port | Fixed | `apps/hub/src/server.ts:223-229` binds `prometheusPort` on dedicated `metricsBindAddr` (defaults to 127.0.0.1) |

## Watchtower

Source: `deepseek_audit_report_watchtower.md`. Closed by commit `e9bf7ec`.

| ID | Severity | Description | Status | Evidence |
|---|---|---|---|---|
| WTW-001 | Critical | Pending events never flushed without new logs | Fixed | `apps/watchtower/src/watcher.ts:135,164` `confirmationFlushInterval` independent flusher |
| WTW-002 | Critical | Deferred penalties lost on restart | Fixed | Scheduler persists durable closing observations before advancing cursor |
| WTW-003 | Critical | Dropped txs never re-broadcast | Fixed | `apps/watchtower/src/responder.ts:121-130` replaces stuck tx with same nonce + bumped fee after `inclusionTimeoutMs` |
| WTW-004 | Critical | Watchtower started with deterministic keys if env empty | Fixed | `apps/watchtower/src/config-validate.ts` rejects known dev keys on non-anvil; mainnet gates explicit |
| WTW-005 | High | `remember()` doesn't validate signatures | Fixed | `apps/watchtower/src/index.ts:261,453` defines and calls `validateSignedState`, persists/remembers only validated states |
| WTW-006 | High | Live path bypasses penalty threshold timing | Fixed | `apps/watchtower/src/index.ts:339` `if (Date.now() < evaluation.submitByMs) return;` — live path returns early until the computed threshold; scheduler remains the delayed path |
| WTW-007 | Medium | Plaintext SQLite DB | Patched-not-reaudited | README clarifies SQLite plaintext + filesystem encryption requirement; encrypted-at-rest implementation deferred to Phase 2 |
| WTW-008 | Medium | `MODE=service` shouldn't be allowed in v1 | Patched-not-reaudited | `config-validate.ts` rejects `MODE=service` |
| WTW-009 | Medium | Confirmations + reorg handling gaps | Fixed | Scheduler applies `confirmations`; storage block-hash rewind |
| WTW-010 | Medium | Tx receipt status not checked | Fixed | `responder.ts:144,237` checks `receipt.status === 'success'` |
| WTW-011 | Low | Config parser too permissive | Fixed | `config-validate.ts` parses with explicit ranges/checks |
| WTW-012 | Low | Health endpoint shallow | Patched-not-reaudited | Health includes scheduler tick + pending-tx age + RPC; full DB probe partial |
| WTW-013 | Low | Recovery test suite incomplete | Fixed | `apps/watchtower/src/recovery.test.ts` covers watchtower restart/recovery scenarios for deferred observations and in-flight submissions |

## Client runtime (SDK + CLI)

Source: `deepseek_audit_report_client_runtime.md`. Closed by commit `e9bf7ec`.

| ID | Severity | Description | Status | Evidence |
|---|---|---|---|---|
| F-01 | Critical | SDK trusts hub-supplied state without verification | Fixed | `packages/sdk/src/client.ts:20-23,389,627,785,916` admit gates from `@inferenceroom/pico-state-machine` wired into all signed-state ingestion paths |
| F-02 | High | Restart consistency gaps | Patched-not-reaudited | Restart still has gaps; subscribe-ack `pendingHtlcs` consumption partial |
| F-03 | High | Invoice replay possible | Fixed | `client.ts:419-421` rejects consumed invoice; `verifyInvoice` called (`client.ts:654`); `storage-file.ts:170` `markInvoiceConsumed` consumed-mark idempotent |
| F-04 | Medium | Hub message decoding too permissive | Patched-not-reaudited | `packages/sdk/src/hub-protocol.ts:191-211` validates JSON shape, kind whitelist, id; full discriminated schema validation per kind not implemented; admit gates compensate downstream |
| F-05 | Medium | Hot key file lacked fsync + perms | Fixed | `storage-file.ts:1,52-55,60,79,104-108` fsyncs file + parent dir, `0o600` files + `0o700` dirs |
| F-06 | Medium | CLI leaks secrets via flags / preimage in stdout | Patched-not-reaudited | Warnings on `--private-key` / env var; `--reveal-preimage` redacts by default; argv-key rejection in production not yet enforced |
| F-07 | Medium | SDK didn't apply default hub fees | Fixed | SDK defaults to `DEFAULT_HUB_FEE_BPS/FLAT` from protocol constants; hub-advertised quote tracked under H-10 |
| F-08 | Low | DVM adapter shipped as if production-ready | Fixed | `dvm-adapter/src/listener.ts:2,22-25` `@experimental` markers, throws on use; `SelectOpts` cleaned up |
| F-09 | Low | Zero-address allowed for contract addresses | Fixed | Hub `config-validate.ts:54-71` rejects zero addresses; CLI uses `Adjudicator` for verifyingContract |
| F-10 | Low | Test-only SDK exports public on npm | Fixed | `packages/sdk/package.json:10-15` exports only the public package root; test helpers live outside the npm export surface |

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
| EOD-08 | High | SECURITY.md placeholder; no PGP key | Patched-not-reaudited | `SECURITY.md`, `pgp-key.asc.placeholder`, `docs/runbooks/security-disclosure.md`, and `.github/workflows/security-md-lint.yml` are aligned on `security@taiko.xyz`, but the real PGP key/fingerprint remains an operator gate |
| EOD-09 | Low | ROADMAP.md status drift | Fixed | This commit syncs P8/P9/P10 statuses |
| EOD-10 | Low | Watchtower DB encryption-at-rest unclear | Patched-not-reaudited | README + watchtower runbook clarify SQLite plaintext + filesystem encryption requirement |
| EOD-11 | Low | README links broken | Fixed | README links updated to `docs/learning/` |

## PR #127 follow-up findings (issue #128)

Identified during the gap-closure pass for PR #127. Landed in the follow-up PR
closing issue #128.

| ID | Severity | Description | Status | Evidence |
|---|---|---|---|---|
| R-04 | Medium | Wallet-level nonce race on concurrent `submitPenalty` | Fixed | `apps/watchtower/src/mutex.ts` new `Mutex`; `responder.ts` wraps `_submitPenalty` in `walletMutex.run()`; test `responder.concurrentNonce.test.ts` asserts distinct nonces under concurrent calls |
| R-05 | Medium | Block-hash absent on observations; reorg-evicted penalty tx not re-submitted | Fixed | `storage.ts` adds `block_hash`/`block_number` columns via `_migrations` table; `markObservationIncluded` stores them; `rewindForReorg(fromBlock)` clears inclusion state and returns affected channelIds; test `responder.reorg.test.ts` |
| R-06 | Medium | Per-token HTLC cap hardcoded; not exposed on `/v1/info` | Fixed | `config.ts` parses `PICO_HUB_PER_COUNTERPARTY_CAP_<token>=<value>` env vars with ETH/PTST defaults; `RouterDeps.perCounterpartyCaps` replaces hardcoded map; `GET /v1/info` returns `perCounterpartyCaps`; SDK README documents shape; test `router.perCounterpartyCap.test.ts` |

## Stale-claim sweep (non-audit-ID items)

| Item | Status | Notes |
|---|---|---|
| `ROADMAP.md` P8 row | Superseded | No `ROADMAP.md` exists in this checkout; launch state now lives in issue #21 plus `docs/launch-log.md` |
| `SECURITY.md` "research-grade" framing | Fixed | Replaced with operable disclosure surface |
| `docs/runbooks/*.md` `DRAFT` markers | Patched | `backup-restore.md` updated; remaining four (`hub-incident.md`, `watchtower-down.md`, `dispute-response.md`, `key-rotation.md`) still carry the README-level DRAFT marker pending operational drills |
| `infra/README.md` `(TODO P9)` placeholder | Fixed | Replaced with `fly/README.md` pointer |
| `e2e/src/scenarios.fork.test.ts` USDC TODO | Fixed | WS-16 closed by whale impersonation |
| `docs/plans/10-launch.md` "⚪ planning only" | Superseded | No `docs/plans/10-launch.md` exists in this checkout; v1 release notes draft is `docs/release-notes-v1.0-draft.md` |

## Provenance

This file was generated by reading every cited line against the current
code at HEAD. If you find a status that no longer matches the source,
please file an issue and update the row in the same PR that reconciles it.
