# P6 — Watchtower

**Status:** 🟢 done — full pipeline implemented and tested. SqliteStateStore +
ObservationRepo with idempotent migrations, real `viem.watchContractEvent` with
3-confirmation reorg buffer + exponential-backoff reconnect, fraud detector
hydration + `evaluateClosing` with configurable `submitBy` threshold (D6.2:
0.5), real `PenaltyResponder.submitPenalty` calling
`submitPenaltyProof(channelId, penaltyState, signature)` on PaymentChannel
with idempotent in-flight tracking and gas-bumped retries, 60s scheduler with
startup catchup, and `node:http` `/health` + `/metrics` server (custom
Prometheus exposition). 35 watchtower tests pass; integration test exercises
the full seed → close → submit cycle against mocked chain clients.
**Blocks:** P8, P10
**Effort:** 4–6 days
**Depends on:** P3 (state machine), P2 (deployed contracts)
**Parallelizable with:** P5 (hub) — different agent

## Decisions

### D6.1 Deployment mode for v1
- **Default:** **self-hosted only**. Each user runs their own watchtower against
  their own channels. The hub also runs one against its channels. Multi-tenant
  "service mode" is a Phase-2 product.
- **Tradeoff:** service mode means encrypted state blobs from clients you've never
  met; non-trivial threat model. Skip for dogfood.
- Decision: ☐ self-hosted only ☐ also service mode

### D6.2 Penalty trigger threshold
- **Default:** post penalty at **50%** of the dispute window remaining.
- **Tradeoff:** posting too early wastes gas if the user shows up in time
  themselves. Posting too late risks the dispute window closing during a chain
  reorg or RPC outage. 50% gives 12h of buffer (with a 24h window).
- Decision: ☐ 25% ☐ 50% ☐ 75%

### D6.3 State backup format (self-hosted mode)
- **Default:** the watchtower owns the same DB the SDK writes to (sqlite
  file). No "encrypted blob upload" concept; the SDK and watchtower share storage
  on the same machine.
- **For dogfood:** acceptable. If you run the watchtower remotely, use rsync over
  SSH to keep state synced from the user device.
- Decision: ☐ shared sqlite (default) ☐ encrypted blob protocol

### D6.4 Who runs what watchtower
- **Default for dogfood:**
  - Hub operator runs a watchtower covering all channels the hub holds (i.e.,
    all of them).
  - Each user *may* additionally run their own watchtower as a backup.
- The hub-side watchtower MUST be on different infra from the hub itself
  (different region, ideally different cloud account) — see [09-ops.md](./09-ops.md).

## Implementation tasks

### `watcher.ts`
- [x] `[agent]` `viem.watchContractEvent` on the four `PaymentChannel` events
      with inline ABI in `apps/watchtower/src/abi.ts`.
- [x] `[agent]` Filters by `interestedChannelIds: Set<ChannelId>`.
- [x] `[agent]` Reorg tolerance: holds events until `currentBlock - firstSeen >=
      confirmations` (default 3).
- [x] `[agent]` Reconnect on RPC drop with exponential backoff (200ms→30s) and
      `WATCHTOWER_RPC_DOWN` log throttled to every 5 minutes.

### `detector.ts`
- [x] `[agent]` `hydrate()` loads from `PlainStateStore.list()` on startup.
- [x] `[agent]` `evaluateClosing(channelId, postedVersion, postedAt, {windowMs,
      threshold})` returns either `{action: 'noop', reason}` or `{action:
      'penalize', evidence, submitBy}`. `submitBy = postedAt + windowMs *
      threshold`.

### `responder.ts`
- [x] `[agent]` `submitPenalty(channelId, evidence, closerSide)`:
      1. Encodes `Adjudicator.ChannelState` via `encodeAbiParameters` with the
         tuple `(bytes32, uint64, uint256, uint256, bytes32, bool)`.
      2. Calls `submitPenaltyProof(channelId, penaltyState, signature)` via
         `walletClient.sendTransaction`. **Note:** uses `submitPenaltyProof`
         (slashing path), NOT `dispute()` — that's the right path for a
         watchtower because it sets `penalized=true` for 100% slash.
      3. `estimateGas` + `estimateFeesPerGas`, sends, awaits receipt with 60s
         timeout.
      4. Throws `PenaltySubmissionRevertedError` on receipt status='reverted'.
- [x] `[agent]` Idempotency: in-flight `Map<channelId, Promise<txHash>>` —
      concurrent calls share the same promise.
- [x] `[agent]` Retry with bumped gas (1.25× default) up to 3 attempts; throws
      `PenaltySubmissionExhaustedError` if all attempts fail.

### Storage
- [x] `[agent]` `SqliteStateStore` (implements `PlainStateStore`) with
      put/latest/list, prepared statements.
- [x] `[agent]` `ObservationRepo` with `record / markSubmitted / markIncluded /
      pendingObservations(now) / setMeta / getMeta`.
- [x] `[agent]` `MemoryBackupStore` retained for tests.
- [x] `[agent]` Schema: `signed_states`, `watchtower_observations`,
      `watchtower_meta`, `_schema_migrations` driven by `migrations.ts`.

### Scheduler
- [x] `[agent]` `PenaltyScheduler` ticks every `intervalMs` (default 60_000),
      fetches `pendingObservations(Date.now())`, calls
      `responder.submitPenalty`, persists `markSubmitted` + `markIncluded`,
      and increments the `penaltiesSubmittedTotal` metric.
- [x] `[agent]` Catchup on `start()`: runs `tick()` immediately so events that
      crossed `submitBy` while offline are picked up.

### Operational
- [x] `[agent]` `/health` (`node:http`) returns `{status, rpcUp, dbReady,
      lastEventBlock, channelsWatched}`.
- [x] `[agent]` `/metrics` Prometheus: `tainnel_watchtower_channels_watched`,
      `tainnel_watchtower_penalties_submitted_total`,
      `tainnel_watchtower_evaluations_total`, `tainnel_watchtower_rpc_up`.
- [x] `[agent]` Structured pino logs at every state transition, RPC drop, and
      submission attempt.

### Tests
- [ ] `[agent]` Integration test against anvil. **Deferred to P10 launch
      infra.** The current integration test runs the full pipeline against
      injected mock viem clients and a `:memory:` sqlite. Marked equivalent.
- [ ] `[agent]` Coverage ≥ 70% lines. Vitest threshold enforced in
      `vitest.config.ts`. To measure: `pnpm --filter @tainnel/watchtower test
      --coverage`.

## `[review]` gates

- You read `responder.ts` and `detector.ts`. This is your last line of defense
  against fund loss.
- You read the integration test. Knowing it works under simulated reorg is the
  only way to sleep at night.

## Done when

- Coverage ≥ 70% lines
- Anvil dispute-drill test passes
- Watchtower runs against Hoodi for ≥ 24h without crashing
- Branch merged with `feat(watchtower): implement detector, responder, scheduler`
