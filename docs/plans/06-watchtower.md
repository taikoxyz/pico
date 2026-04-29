# P6 — Watchtower

**Status:** 🔵 not started — `watcher`, `detector`, `responder`, `storage` are
shells; `detector` has the only real logic
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
- [ ] `[agent]` Subscribe via `viem.watchContractEvent` to all four events on the
      deployed `PaymentChannel` (`ChannelOpened`, `ChannelClosingUnilateral`,
      `DisputeRaised`, `ChannelFinalized`).
- [ ] `[agent]` Filter to channels we care about (read from the shared DB or a
      provided `interestedChannelIds` set).
- [ ] `[agent]` Reorg tolerance: only act on events with ≥ 3 confirmations.
- [ ] `[agent]` Reconnect on RPC drop with exponential backoff; emit a
      `WATCHTOWER_RPC_DOWN` log every 5 minutes if disconnected (to fire alerts).

### `detector.ts`
- [ ] `[agent]` Already half-implemented (`remember`/`evaluate`). Hydrate `latest`
      from the DB on startup.
- [ ] `[agent]` Add `evaluateClosing(channelId, postedVersion, postedAt)` that
      returns either `{action: 'noop', reason}` or `{action: 'penalize', evidence,
      submitBy: timestamp}` where `submitBy` is `postedAt + windowMs * threshold`.

### `responder.ts`
- [ ] `[agent]` `submitPenalty(channelId, evidence)`:
      1. Build the `dispute` (or `submitPenaltyProof`) calldata via viem
      2. Estimate gas, set max fee
      3. Sign with the watchtower's private key
      4. Submit and wait for inclusion
      5. Persist `{tx_hash, submittedAt, includedAt}` for postmortem
- [ ] `[agent]` Idempotency: if there's already a tx in flight for this channelId,
      no-op.
- [ ] `[agent]` Retry with bumped gas if not mined within 60s.

### Storage
- [ ] `[agent]` `MemoryBackupStore` is in place; add `SqliteBackupStore` that
      reads/writes the shared sqlite file (per D6.3).
- [ ] `[agent]` Schema: `watchtower_observations` table (channel_id, posted_version,
      posted_at, our_latest_version, action_taken, tx_hash).

### Scheduler
- [ ] `[agent]` Every 60s, scan open `closeUnilateral` events for any whose
      `submitBy` has been crossed without us submitting; trigger responder.
- [ ] `[agent]` Run on startup: catches up on events that fired while we were
      offline, before the dispute window closes.

### Operational
- [ ] `[agent]` `/health` HTTP endpoint exposing: RPC reachable, DB reachable,
      last-event-block-number, channels-watched-count.
- [ ] `[agent]` `/metrics` Prometheus: `tainnel_watchtower_channels_watched`,
      `tainnel_watchtower_penalties_submitted_total`,
      `tainnel_watchtower_evaluations_total`, `tainnel_watchtower_rpc_up`.
- [ ] `[agent]` Structured logs at every step.

### Tests
- [ ] `[agent]` Integration test against anvil:
      - open a channel
      - hub posts an old state via `closeUnilateral`
      - watchtower observes within window
      - watchtower submits dispute
      - state is replaced; finalize gives funds to honest party
- [ ] `[agent]` **Listen-mode + watchtower recovery:** simulate "hub cheats while
      user is offline; user runs `tainnel listen` later; watchtower has already
      penalized". Assert the agent's state DB ends up consistent with the on-chain
      finalization and no dangling in-flight HTLCs are left over.
- [ ] `[agent]` Coverage ≥ 70%.

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
