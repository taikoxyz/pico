# Watchtower Audit Report

## Executive summary

`apps/watchtower` is not mainnet-ready. The happy path is present and covered by an anvil integration test, but several failure paths can cause missed penalties or false readiness:

- Confirmed stale-close events can remain pending forever because confirmation-gated watcher events are only flushed when new logs arrive.
- Restart/catch-up behavior can permanently drop deferred penalties by advancing `last_processed_block_number` before a penalty is submitted or queued.
- Persisted in-flight transactions become an idempotent no-op after restart or timeout, so underpriced/dropped penalty transactions are not fee-bumped.
- Signed-state ingestion accepts and persists arbitrary higher-version states without signature, channel, balance, or HTLC validation.
- Mainnet defaults include a public deterministic private key and weak config validation.
- The README's encrypted backup and service-mode claims do not match the implementation.

The service should be treated as a prototype with a passing happy path, not as a fund-safety service.

## Component boundary

Audited code:

- Watcher: `apps/watchtower/src/watcher.ts`
- Detector: `apps/watchtower/src/detector.ts`
- Responder: `apps/watchtower/src/responder.ts`
- Scheduler/catch-up: `apps/watchtower/src/scheduler.ts`
- Storage/restart durability: `apps/watchtower/src/storage.ts`
- Runtime wiring: `apps/watchtower/src/index.ts`
- Config: `apps/watchtower/src/config.ts`, `apps/watchtower/.env.example`
- Health/metrics: `apps/watchtower/src/http.ts`, `apps/watchtower/src/metrics.ts`
- Tests/docs: `apps/watchtower/src/*.test.ts`, `apps/watchtower/README.md`

Relevant external contracts/protocol code used for safety context:

- `packages/contracts/src/PaymentChannel.sol`
- `packages/state-machine/src/signing.ts`
- `packages/protocol/src/types.ts`
- `packages/protocol/src/constants.ts`

## Findings table

| ID | Severity | Area | Finding |
| --- | --- | --- | --- |
| WTW-001 | Critical | Watcher | Confirmation-gated events may never dispatch without later logs. |
| WTW-002 | Critical | Scheduler/recovery | Catch-up advances progress for deferred penalties, losing them after restart. |
| WTW-003 | Critical | Responder/recovery | Persisted pending transactions are never retried or fee-bumped after restart/timeout. |
| WTW-004 | Critical | Config | Default mainnet config uses a public deterministic private key and lacks safety gates. |
| WTW-005 | High | Signed-state ingestion | Higher-version signed states are accepted and overwrite evidence without validation. |
| WTW-006 | High | Timing/config | Live watcher path ignores the configured penalty threshold. |
| WTW-007 | High | Storage/docs | State backups are stored as plaintext JSON despite encrypted-backup docs. |
| WTW-008 | High | Mode boundary | `service` mode is parsed but not implemented as a separate safe operating mode. |
| WTW-009 | High | Catch-up/reorg | Catch-up scans to head without confirmations and persists progress without reorg protection. |
| WTW-010 | Medium | Responder/accounting | Mined penalty receipts are not checked for `status === "success"` in the main wait path. |
| WTW-011 | Medium | Config validation | Numeric, address, private-key, and channel-id config values are weakly validated. |
| WTW-012 | Medium | Health/metrics | Health can report ready while DB, scheduler, pending tx, or deadline safety is degraded. |
| WTW-013 | Info | Validation | Tests cover the happy-path stale-state penalty but not the critical recovery paths above. |

## Detailed findings

### WTW-001: Confirmation-gated events may never dispatch without later logs

Severity: Critical

Evidence file references:

- `apps/watchtower/src/watcher.ts:182-189` stores decoded logs in `pending` and calls `flushConfirmed()` only from `onLogs`.
- `apps/watchtower/src/watcher.ts:238-285` dispatches pending events only inside `flushConfirmed()`.
- `apps/watchtower/src/watcher.test.ts:127-134` manually calls `watcher.__forFlush()` after advancing the mock head to release a pending event; there is no equivalent production block timer.

Observed behavior:

An event observed before the configured confirmation depth is placed in `pending`. If no later contract log arrives, there is no periodic head poll or block subscription that calls `flushConfirmed()` when the event becomes confirmed.

Impact:

A unilateral close can be seen but never evaluated or penalized. On low-activity contracts, this can miss the entire dispute window.

Recommended fix:

Add a production confirmation flusher independent of `onLogs`, such as a block watcher or interval that calls `flushConfirmed()` while `pending.size > 0`. Add bounded retry/backoff and metrics for oldest pending event age.

Tests/checks needed:

- Unit test: emit one close log at head N, advance head past confirmations without emitting another log, and assert handler fires without calling test-only `__forFlush()`.
- Integration test: close a channel and mine empty blocks only; assert the penalty is submitted.

### WTW-002: Catch-up advances progress for deferred penalties, losing them after restart

Severity: Critical

Evidence file references:

- `apps/watchtower/src/scheduler.ts:98-105` processes catch-up logs, then writes `last_processed_block_number` for the chunk.
- `apps/watchtower/src/scheduler.ts:132-133` returns without submission when `now < result.submitByMs`.
- `apps/watchtower/src/index.ts:139-153` adds closing channels to the in-memory `closingChannels` map only from live watcher events.
- `apps/watchtower/src/index.ts:204-216` gives the scheduler only `closingChannels.values()` as its recurring provider.

Observed behavior:

If catch-up sees a stale close before the penalty threshold time, `evaluateAndSubmit()` returns early. The catch-up loop still marks the block processed. It does not persist a closing-channel work item, and it does not add the caught-up close to the in-memory `closingChannels` map.

Impact:

After a restart during the first half of the dispute window, a stale close can be marked processed and never revisited when the threshold arrives. This is a direct missed-penalty/fund-safety failure.

Recommended fix:

Persist closing observations/work items separately from log progress. Catch-up should enqueue or update a durable closing record before advancing progress. The scheduler should poll durable open closing records until they are penalized, finalized, expired, or proven not stale.

Tests/checks needed:

- Restart test: catch-up observes a stale close before threshold, process restarts, time advances past threshold, and penalty still submits.
- Ensure `last_processed_block_number` advances only after the durable work item is written.

### WTW-003: Persisted pending transactions are never retried or fee-bumped after restart/timeout

Severity: Critical

Evidence file references:

- `apps/watchtower/src/responder.ts:111-122` returns the existing pending tx hash when no receipt is found.
- `apps/watchtower/src/responder.ts:190-201` persists an in-flight tx after initial submission.
- `apps/watchtower/src/responder.ts:204-225` only fee-bumps inside the same long-running `submitPenalty()` call.
- `apps/watchtower/src/storage.ts:48-55` stores `submittedAtMs`, `nonce`, `maxFeePerGas`, and `attempts`, but the restart path does not use them to decide whether to bump.
- `apps/watchtower/src/responder.test.ts:137-168` codifies the pending in-flight no-op behavior.

Observed behavior:

In-flight transaction persistence exists, but on the next call the responder treats a receipt-less tx as an idempotent no-op. It does not compare `submittedAtMs` to `inclusionTimeoutMs`, does not reuse the stored nonce to replace the tx, and does not increment stored attempts.

Impact:

If the process crashes after submission, the tx is dropped from the mempool, or the tx is underpriced through the deadline, the watchtower can wait forever and miss the penalty window.

Recommended fix:

Implement a durable pending-tx recovery state machine:

- If `now - submittedAtMs >= inclusionTimeoutMs`, resubmit with the same nonce and bumped fee.
- Persist each replacement hash, fee, attempt count, and last error.
- Stop only when a successful receipt is observed, the channel is already penalized/finalized, or the dispute deadline has expired.
- Surface oldest pending age and deadline remaining in metrics.

Tests/checks needed:

- Restart test with an in-flight row older than timeout and no receipt; assert same-nonce replacement is sent.
- Dropped-tx test: receipt absent across multiple scheduler ticks; assert fee bump attempts progress.
- Deadline-expired test: mark observation lost/expired instead of silent no-op.

### WTW-004: Default mainnet config uses a public deterministic private key and lacks safety gates

Severity: Critical

Evidence file references:

- `apps/watchtower/src/config.ts:40-45` defaults to port 3031, mainnet RPC, and `0x...0002` as `WATCHTOWER_PRIVATE_KEY`.
- `apps/watchtower/src/config.ts:58-62` defaults `CHAIN_ID` to Taiko mainnet when unset.
- `apps/watchtower/.env.example:1-5` shows the same deterministic private key and mainnet RPC.
- `apps/watchtower/src/config.test.ts:6-20` asserts the empty environment uses mainnet defaults.

Observed behavior:

Running with an empty or copied example environment starts against Taiko mainnet with a known private key.

Impact:

The responder may be unable to pay gas, or worse, an operator may fund a publicly known key. This is an immediate mainnet readiness blocker.

Recommended fix:

Require `WATCHTOWER_PRIVATE_KEY` explicitly for any non-test chain; reject known dev keys on mainnet. Prefer loading encrypted key files or external signers. Make `.env.example` use a placeholder such as `WATCHTOWER_PRIVATE_KEY=replace-me` and fail fast if it remains unchanged.

Tests/checks needed:

- Config tests that empty mainnet env fails without an explicit key.
- Config tests that known dev keys are accepted only on `CHAIN_ID=31337`.

### WTW-005: Higher-version signed states are accepted and overwrite evidence without validation

Severity: High

Evidence file references:

- `apps/watchtower/src/index.ts:241-243` exposes `remember(state)` and directly stores/remembers the input.
- `apps/watchtower/src/detector.ts:34-37` accepts any strictly newer version per channel.
- `apps/watchtower/src/storage.ts:169-179` persists the serialized state and signatures directly.
- `apps/watchtower/src/storage.ts:272-282` overwrites the prior state when the new version is greater.
- `packages/state-machine/src/signing.ts:181-190` provides `verifyChannelStateSignature()`, but `apps/watchtower` does not call it.
- `packages/contracts/src/PaymentChannel.sol:266-272` requires matching channel id, newer version, empty HTLC root, conserved balances, and the closer's signature.

Observed behavior:

The watchtower trusts `SignedState` objects at ingestion. It does not verify either signature against on-chain participants, does not read channel funding to validate balance conservation, does not reject non-empty HTLC roots, and does not check that the evidence can satisfy the penalty contract.

Impact:

A malformed or forged high-version state can replace valid evidence. The detector then selects unusable evidence, and the responder can repeatedly revert or miss the valid penalty.

Recommended fix:

Create an ingestion validator that:

- Reads channel participants, token/funding, status, and contract address.
- Verifies `sigA` and `sigB` with `verifyChannelStateSignature()` against `userA` and `userB` under the correct chain id/verifying contract.
- Enforces channel id match, monotonic version, empty HTLCs for penalty-capable states, non-finalized penalty evidence, and conserved balances.
- Keeps prior valid evidence until the replacement is fully validated.

Tests/checks needed:

- Reject forged higher-version state and preserve prior valid state.
- Reject state with non-empty HTLCs or non-conserved balances.
- Verify both signatures against on-chain channel participants.

### WTW-006: Live watcher path ignores the configured penalty threshold

Severity: High

Evidence file references:

- `apps/watchtower/src/detector.ts:85-89` returns `submitByMs` based on `postedAtMs + windowMs * thresholdRatio`.
- `apps/watchtower/src/scheduler.ts:132-133` respects `submitByMs`.
- `apps/watchtower/src/index.ts:154-175` immediately calls `responder.submitPenalty()` for live close events whenever `evaluation.action === "penalize"`, without checking `submitByMs`.
- `apps/watchtower/src/config.ts:51` exposes `PENALTY_THRESHOLD`.

Observed behavior:

The same stale close is delayed in the scheduler path but submitted immediately in the live watcher path.

Impact:

Operator-configured penalty timing is not reliable. This can violate the intended response policy and makes threshold behavior dependent on whether the close was seen live or during scheduled evaluation.

Recommended fix:

Make live watcher and scheduler share one durable evaluation path. Live watcher should enqueue/update the closing record; scheduler should be the only component that decides when to submit based on the configured threshold and deadline.

Tests/checks needed:

- Live event test: before threshold, no submission; after threshold, submission.
- Config test that a custom threshold affects both live and catch-up paths consistently.

### WTW-007: State backups are stored as plaintext JSON despite encrypted-backup docs

Severity: High

Evidence file references:

- `apps/watchtower/README.md:3-6` says the service stores encrypted state backups.
- `apps/watchtower/src/storage.ts:5-20` defines encrypted and plain store interfaces, but the runtime uses `SqliteWatchtowerStore`.
- `apps/watchtower/src/storage.ts:130-136` creates `state_json`, `sig_a_json`, and `sig_b_json` text columns.
- `apps/watchtower/src/storage.ts:169-179` writes serialized state and signatures directly.
- `apps/watchtower/src/index.ts:62-67` creates the SQLite store and hydrates detector state from it.

Observed behavior:

State backups and signatures are stored in plaintext SQLite. The encrypted backup abstraction is not wired into the runtime path.

Impact:

This is a privacy and service-custody risk, and it contradicts the operational documentation. In service mode, plaintext multi-tenant signed states would be especially sensitive.

Recommended fix:

Either implement encryption-at-rest for signed states before mainnet/service use, or update docs and threat model to state that local plaintext storage is required. For service mode, require per-tenant envelope encryption and avoid storing decryptable state without an explicit custody model.

Tests/checks needed:

- Storage test that persisted rows do not contain raw `channelId`, balances, or signatures when encryption is enabled.
- Recovery test that encrypted rows hydrate correctly after restart.

### WTW-008: `service` mode is parsed but not implemented as a separate safe operating mode

Severity: High

Evidence file references:

- `apps/watchtower/README.md:8-11` describes self-hosted and service modes.
- `apps/watchtower/src/config.ts:16` includes `mode: "self-hosted" | "service"`.
- `apps/watchtower/src/config.ts:27` parses `MODE=service`.
- `apps/watchtower/src/index.ts:260-278` logs `mode` but does not pass it into different runtime behavior.
- `apps/watchtower/src/http.ts:18-35` exposes only `/health` and `/metrics`, not authenticated encrypted state ingestion.

Observed behavior:

Service mode changes a config field and log metadata only. It does not add tenant isolation, authentication, encrypted blob ingestion, quota/rate limits, per-tenant channel filtering, or separate key management.

Impact:

Operators could believe a multi-tenant watchtower mode exists when the process is still a single-key, single-store, plaintext self-hosted implementation.

Recommended fix:

Fail fast on `MODE=service` until the service-mode boundary is implemented, or implement the full service API and security model. Keep self-hosted mode explicit and narrow.

Tests/checks needed:

- Config/runtime test that `MODE=service` fails with a clear unsupported-mode error until implemented.
- If implemented, auth, tenant isolation, encrypted ingestion, and per-tenant recovery tests.

### WTW-009: Catch-up scans to head without confirmations and persists progress without reorg protection

Severity: High

Evidence file references:

- `apps/watchtower/src/scheduler.ts:72-96` sets `head = getBlockNumber()` and scans up to `head`.
- `apps/watchtower/src/scheduler.ts:104` persists `last_processed_block_number` to the chunk end.
- `apps/watchtower/src/watcher.ts:248-250` has confirmation logic for live events, but catch-up does not apply the configured confirmation depth.

Observed behavior:

Startup catch-up processes unconfirmed head blocks and stores them as processed. If those blocks reorg out, the stored cursor can skip replacement logs at the same or lower block height.

Impact:

On mainnet, a reorg around a unilateral-close event can lead to missed or duplicate handling. For fund safety, catch-up should have at least the same finality policy as the live watcher.

Recommended fix:

Apply `confirmations` to catch-up by scanning only to `safeHead = head - confirmations`. Store block hash alongside block number, and rewind on mismatch. Consider a small overlap window on every catch-up cycle.

Tests/checks needed:

- Catch-up test that with head 100 and confirmations 3 scans only to 97.
- Reorg simulation: stored block hash mismatch causes rewind and replay.

### WTW-010: Mined penalty receipts are not checked for success in the main wait path

Severity: Medium

Evidence file references:

- `apps/watchtower/src/responder.ts:204-219` treats any non-null receipt returned by `tryWaitForReceipt()` as a submitted penalty.
- `apps/watchtower/src/responder.ts:123-132` checks `receipt.status === "success"` in the existing-in-flight path, showing status is available and relevant.
- `packages/contracts/src/PaymentChannel.sol:263-272` has several deterministic revert conditions for penalty proofs.

Observed behavior:

The initial/retry wait path increments metrics, marks observations included, clears in-flight, and returns the tx hash without checking `receipt.status`.

Impact:

Verification needed: if the viem version in use returns reverted receipts instead of throwing for `waitForTransactionReceipt()`, the watchtower can mark a failed penalty as included and clear recovery state.

Recommended fix:

Require `receipt.status === "success"` before marking included. If status is reverted, persist a terminal or retryable failure according to the current channel/deadline state.

Tests/checks needed:

- Unit test where `waitForTransactionReceipt()` resolves `{ status: "reverted" }`; assert no success metric, no included mark, and recovery state is retained or marked failed.

### WTW-011: Numeric, address, private-key, and channel-id config values are weakly validated

Severity: Medium

Evidence file references:

- `apps/watchtower/src/config.ts:29-30` casts `PAYMENT_CHANNEL_ADDRESS` to `Address` without format validation.
- `apps/watchtower/src/config.ts:34-37` casts `INTERESTED_CHANNEL_IDS` without bytes32 validation.
- `apps/watchtower/src/config.ts:40-54` parses numbers with `Number(...)` but does not reject `NaN`, negative values, zero confirmations, or out-of-range penalty thresholds.
- `apps/watchtower/src/config.ts:58-62` supports only mainnet and anvil despite `ChainId` including Hoodi in `packages/protocol/src/types.ts:8`.

Observed behavior:

Invalid environment values can flow into runtime as `NaN`, invalid addresses, invalid channel IDs, unsafe thresholds, or unsupported chain behavior.

Impact:

Misconfiguration can silently disable delayed submissions, prevent watcher filtering, connect to the wrong chain abstraction, or crash at runtime instead of failing fast.

Recommended fix:

Use explicit parsers for all env fields:

- `PENALTY_THRESHOLD` in `[0, 1]`.
- Positive integer `SCHEDULER_INTERVAL_MS`, `CONFIRMATIONS`, `RPC_RECONNECT_MAX_BACKOFF_MS`.
- 32-byte private key.
- EIP-55/hex address for `PAYMENT_CHANNEL_ADDRESS`.
- 32-byte channel IDs.
- Explicit supported chain list with correct viem chain mapping.

Tests/checks needed:

- Negative/NaN/out-of-range config tests.
- Invalid address/private-key/channel-id tests.
- Hoodi behavior either supported explicitly or rejected with documentation.

### WTW-012: Health can report ready while DB, scheduler, pending tx, or deadline safety is degraded

Severity: Medium

Evidence file references:

- `apps/watchtower/src/index.ts:224-228` hardcodes `db: { up: true }` in the health probe.
- `apps/watchtower/src/http.ts:18-30` returns 200 when `rpc.up && db.up`.
- `apps/watchtower/src/metrics.ts:6-28` exposes channel count, submitted penalties, evaluations, and RPC up only.

Observed behavior:

Health does not actually query SQLite, report scheduler/catch-up state, expose pending transaction age, track oldest closing deadline, or flag failed submission loops.

Impact:

Operators can see HTTP 200 while the service is no longer capable of protecting funds.

Recommended fix:

Health should include at least:

- SQLite read/write probe or last successful store operation.
- Scheduler tick timestamp and catch-up cursor.
- Oldest pending tx age and attempts.
- Oldest closing deadline remaining.
- Last penalty submission error.

Tests/checks needed:

- Health test where DB probe fails returns 503.
- Health/metrics test where stale pending tx or expired closing channel is visible.

### WTW-013: Tests cover the happy-path stale-state penalty but not critical recovery paths

Severity: Info

Evidence file references:

- `apps/watchtower/src/integration.test.ts:329-453` verifies an anvil stale-state attack where the watchtower submits a penalty and Alice recovers funds.
- `apps/watchtower/src/watcher.test.ts:109-141` confirms confirmation gating with manual flushing.
- `apps/watchtower/src/responder.test.ts:170-222` covers fee bump only within one active call.
- Missing tests are noted in WTW-001 through WTW-012.

Observed behavior:

The happy path is exercised, but restart, dropped mempool tx, deferred threshold catch-up, reorg, invalid-state ingestion, and health false-positive cases are not covered.

Impact:

Current tests can pass while mainnet readiness blockers remain.

Recommended fix:

Add a recovery-focused suite around durable work queues, restart from SQLite, in-flight tx replacement, and catch-up/reorg behavior.

Tests/checks needed:

- See the test lists in WTW-001 through WTW-012.

## Readiness blockers

Mainnet/service readiness is blocked by:

- WTW-001: pending watcher events can miss the dispute window.
- WTW-002: catch-up can lose deferred penalties after restart.
- WTW-003: pending tx recovery does not replace stuck/dropped transactions.
- WTW-004: default mainnet private key is public and unsafe.
- WTW-005: signed-state evidence is not validated before becoming canonical.
- WTW-007 and WTW-008: encrypted storage and service mode are documented but not implemented.
- WTW-009: catch-up lacks finality/reorg safety.

## Validation notes

This audit was based on read-only source inspection. I did not run build, typecheck, or test commands because they can create caches/artifacts, and the task asked to modify only this report file.

Read-only commands used included:

- `rg --files apps/watchtower`
- `nl -ba` over watchtower source, tests, README, and config files
- `rg` across protocol, SDK, state-machine, contracts, and watchtower for signature, threshold, storage, watcher, and service-mode evidence
- `git status --short` scoped to the requested report path and sibling audit report pattern

No source, config, test, or other audit report files were modified.
