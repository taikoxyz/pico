# P6 — Watchtower

**Status:** 🟢 implemented — detector, responder, watcher (4 events + reorg buffer
+ RPC reconnect), scheduler, sqlite backup store, /health + /metrics endpoints,
and an end-to-end anvil dispute drill all land in this branch. P7-coupled
listen-mode recovery test is deferred to P7.
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
- Decision: ☑ self-hosted only ☐ also service mode

### D6.2 Penalty trigger threshold
- **Default:** post penalty at **50%** of the dispute window remaining.
- **Tradeoff:** posting too early wastes gas if the user shows up in time
  themselves. Posting too late risks the dispute window closing during a chain
  reorg or RPC outage. 50% gives 12h of buffer (with a 24h window).
- Decision: ☐ 25% ☑ 50% ☐ 75%

### D6.3 State backup format (self-hosted mode)
- **Default:** the watchtower owns the same DB the SDK writes to (sqlite
  file). No "encrypted blob upload" concept; the SDK and watchtower share storage
  on the same machine.
- **For dogfood:** acceptable. If you run the watchtower remotely, use rsync over
  SSH to keep state synced from the user device.
- Decision: ☑ shared sqlite (default) ☐ encrypted blob protocol

### D6.4 Who runs what watchtower
- **Default for dogfood:**
  - Hub operator runs a watchtower covering all channels the hub holds (i.e.,
    all of them).
  - Each user / agent *may* additionally run their own watchtower as a backup.
- The hub-side watchtower MUST be on different infra from the hub itself
  (different region, ideally different cloud account) — see [09-ops.md](./09-ops.md).

### Pairing with `tainnel listen` (P7)

When an agent runs `tainnel listen` (P7), it MAY subscribe to the same chain events
this watchtower listens to. The two are not mutually exclusive — an agent's listen
mode is a convenience for the agent itself, while the watchtower is the canonical
penalty submitter so users do not have to keep a CLI alive 24/7. Recovery
expectations:

- An agent that ran listen-mode while a fraud occurred will see `DisputeRaised` and
  `PenaltyApplied` events from the watchtower; it logs them, does nothing on chain.
- An agent that was offline during the fraud and starts listen-mode after the fact
  will read the chain history, see that the watchtower already penalized, and reach
  the same final balance as if it had been online.

## Implementation tasks

### `watcher.ts`
- [x] `[agent]` Subscribe via `viem.watchContractEvent` to all four events on the
      deployed `PaymentChannel` (`ChannelOpened`, `ChannelClosingUnilateral`,
      `DisputeRaised`, `ChannelFinalized`).
- [x] `[agent]` Filter to channels we care about (`interestedChannelIds: Set<ChannelId>` opt).
- [x] `[agent]` Reorg tolerance: configurable `confirmations` (default 3); events
      buffered in `pendingByTxHash` and flushed only when `head - blockNumber + 1 ≥ confirmations`;
      receipts re-fetched and reorg-evicted txs dropped.
- [x] `[agent]` Reconnect on RPC drop with exponential backoff (250ms → 30s, ×2 with
      ±10% jitter); emits `WATCHTOWER_RPC_DOWN` every 5 minutes while disconnected.

### `detector.ts`
- [x] `[agent]` `hydrate(states)` bulk-loads from store at startup.
- [x] `[agent]` `evaluateClosing({channelId, postedVersion, postedAtMs, windowMs,
      thresholdRatio = 0.5, alreadyPenalized})` returns the discriminated union
      `{action:'noop', reason: 'unknown_channel' | 'not_stale' | 'already_penalized'}`
      or `{action:'penalize', evidence, submitByMs, latestKnownVersion}`.

### `responder.ts`
- [x] `[agent]` `submitPenalty(channelId, evidence, closerSide, observationId?)`:
      1. Builds `submitPenaltyProof` calldata via viem
      2. `estimateContractGas` + `estimateFeesPerGas` for EIP-1559 fees
      3. Signs with watchtower private key
      4. Submits and waits for inclusion (60s timeout per attempt)
      5. Persists `{tx_hash, submittedAt, includedAt}` to `watchtower_observations`
- [x] `[agent]` Idempotency: reads `in_flight_txs[channelId]`; if present and receipt
      not yet included, returns the existing tx hash as a no-op.
- [x] `[agent]` Retry: bumps `maxFeePerGas`/`maxPriorityFeePerGas` by 25% (capped at 2×
      initial), resubmits with same nonce, up to 4 attempts.

### Storage
- [x] `[agent]` `SqliteWatchtowerStore` (better-sqlite3) implements the new
      `WatchtowerStore` interface. Self-hosted shared sqlite file per D6.3.
      `MemoryBackupStore` retained but unused in default wiring.
- [x] `[agent]` Schema: `signed_states` (hydration source), `watchtower_observations`
      (channel_id, posted_version, posted_at_ms, our_latest_version, action_taken,
      tx_hash, submitted_at_ms, included_at_ms, reason, created_at_ms),
      `in_flight_txs` (idempotency + gas-bump bookkeeping), `meta` (e.g.
      `last_processed_block_number` for catch-up).

### Scheduler
- [x] `[agent]` `Scheduler.tick()` runs every 60s (configurable). Iterates the watcher's
      known closing channels, calls `detector.evaluateClosing`, triggers
      `responder.submitPenalty` for any whose `submitByMs` is crossed and has no
      in-flight tx.
- [x] `[agent]` `Scheduler.catchup()` runs at startup: queries `getContractEvents` for
      `ChannelClosingUnilateral` between `meta.last_processed_block_number` and head
      (bounded by 100k blocks), feeds them through the same evaluate→submit pipeline,
      then persists the new last-processed block.

### Operational
- [x] `[agent]` `GET /health` (Fastify) → `{ rpc: { up, lastEventBlockNumber }, db: { up },
      channelsWatched }`. 200 if both up; 503 otherwise.
- [x] `[agent]` `GET /metrics` (prom-client) exposes `tainnel_watchtower_channels_watched`,
      `tainnel_watchtower_penalties_submitted_total`,
      `tainnel_watchtower_evaluations_total{result}`, `tainnel_watchtower_rpc_up`,
      plus default Node process metrics.
- [x] `[agent]` Structured pino logs at every step (subscribe, fraud detection,
      submission, retry, inclusion, RPC down/up).

### Tests
- [x] `[agent]` Integration test against anvil (`apps/watchtower/src/integration.test.ts`):
      opens a channel via the real SDK, alice does 5 sequential payDirects to v6,
      watchtower remembers each state, hub maliciously posts v3 via `closeUnilateral`,
      watchtower auto-submits `submitPenaltyProof(v6)`, asserts on-chain `posted=6n`
      and `penalized=true`, then `finalize` after `timeWarp`, asserts alice gets
      100% of the channel pot and channel status = Closed.
- [ ] **Listen-mode + watchtower recovery — DEFERRED to P7.** The "agent runs listen
      later" test depends on the `tainnel listen` agent runtime that ships in P7.
      The watchtower's chain-history recovery path (Scheduler.catchup) is exercised
      by `scheduler.test.ts` Test D; the cross-agent state-DB reconciliation needs
      P7's listen-mode runtime to assert against. Re-open this checkbox in P7.
- [x] `[agent]` Coverage ≥ 70% — vitest config enforces this; the dispute drill plus
      9 unit/integration test files cover all of detector, responder, watcher,
      scheduler, storage, http, config, index wiring.

## `[review]` gates

- You read `responder.ts` and `detector.ts`. This is your last line of defense
  against fund loss.
- You read the integration test. Knowing it works under simulated reorg is the
  only way to sleep at night.

## Done when

- Coverage ≥ 70% lines
- Anvil dispute-drill test passes
- Watchtower runs against Taiko mainnet for ≥ 24h without crashing
- Branch merged with `feat(watchtower): implement detector, responder, scheduler`
