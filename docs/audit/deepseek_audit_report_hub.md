# Hub Audit Report

## Executive summary

`apps/hub` is not mainnet-ready. The highest-risk issues are not cosmetic: unauthenticated WebSocket and operator flows can reach fund-moving handlers, inbound states are recorded and countersigned without validating channel membership, signatures, monotonic updates, or HTLC inclusion, and the router can sign conflicting outbound states under concurrency. The current implementation can route a payment even when the incoming signed state does not actually lock the sender's funds, then record a recipient-settled outbound state before failing to settle the incoming side.

The service has useful building blocks: typed channel states, state-machine helpers, a DB transaction abstraction, nonce storage, dispute persistence, metrics, and a chain watcher. The readiness gap is that those pieces are not consistently applied at the WebSocket/API trust boundary or across atomic payment-state transitions.

## Component boundary

Audited scope:

- Hub server/config/API: `apps/hub/src/server.ts`, `apps/hub/src/config.ts`, `apps/hub/src/api/index.ts`, `apps/hub/src/api/ws.ts`, `apps/hub/.env.example`.
- Auth/envelopes: `apps/hub/src/auth/envelope.ts`, `apps/hub/src/db/repos/nonce-repo.ts`.
- Routing/liquidity/persistence: `apps/hub/src/router.ts`, `apps/hub/src/channel-pool.ts`, `apps/hub/src/liquidity.ts`, `apps/hub/src/db/**`, `apps/hub/migrations/001_initial.sql`.
- Chain/dispute handling: `apps/hub/src/chain-watcher.ts`, `apps/hub/src/dispute-handler.ts`.
- Cross-package expectations used by the hub: `packages/sdk/src/client.ts`, `packages/sdk/src/hub-protocol.ts`, `packages/sdk/src/chain-adapter.ts`, `packages/state-machine/src/channel.ts`, `packages/state-machine/src/htlc.ts`, `packages/state-machine/src/signing.ts`, `packages/contracts/src/PaymentChannel.sol`, `packages/contracts/src/interfaces/IPaymentChannel.sol`.

Out of scope:

- Full contract audit, SDK client audit, watchtower audit, deployment infra, and live RPC behavior beyond how `apps/hub` calls them.

## Findings table

| ID | Severity | Finding | Readiness impact |
| --- | --- | --- | --- |
| H-01 | Critical | Incoming payment states and HTLCs are not verified before routing, recording, or countersigning. | Direct fund-loss path: hub can pay outbound without a valid inbound lock. |
| H-02 | Critical | WebSocket auth is disabled by default and, when enabled, is not bound to the message actor/channel. | Any caller can subscribe, pay, settle, fail, or close as another party. |
| H-03 | Critical | Production defaults start on mainnet with a known hub private key and open operator REST API. | Unsafe-by-default deployment can expose channel registration and hub signing authority. |
| H-04 | Critical | Outbound routing is not serialized atomically and can sign conflicting same-version states. | Concurrent payments can create equivocal hub signatures and inconsistent DB/router state. |
| H-05 | High | Payment state, HTLC records, payment rows, and liquidity reservations are written non-atomically. | Crashes/errors leave one side advanced without the durable records needed to settle/recover. |
| H-06 | High | In-flight router state is not rehydrated after restart. | Settles/fails for persisted in-flight HTLCs become unknown after process restart. |
| H-07 | High | Settle/fail handlers remove in-flight state before validation and accept unauthenticated control messages. | A bad settle/fail can grief or strand an in-flight payment; a forged settle can poison state. |
| H-08 | High | Dispute handler uses the latest DB state even when it contains HTLCs; contract disputes require empty HTLC root. | Hub may be unable to dispute a stale close while latest local state is non-empty. |
| H-09 | High | Chain watcher initializes from `head - 1` and stores only a block number, with no historical catch-up/reorg proof. | Restored/new watchers can miss prior unilateral closes; deep reorgs are not detected. |
| H-10 | Medium | HTLC fee math does not match SDK payment expectations unless perfectly configured and grossed up. | Invoice payments can be underpaid or fail; fee defaults differ between hub and SDK. |
| H-11 | Medium | Liquidity tracker is not fed from channel states and reservation failures are ignored after state advancement. | Liquidity metrics are unreliable and reservations do not protect routing decisions. |
| H-12 | Medium | DB schema/repositories lack integrity constraints and update-result checks for fund-state rows. | Silent orphan/no-op writes can hide broken payment/dispute lifecycle state. |
| H-13 | Low | Metrics/config are not production-safe: `PROMETHEUS_PORT` is unused and `/metrics` is public on the main app. | Operational exposure and misleading liquidity values. |

## Detailed findings

### H-01: Incoming payment states and HTLCs are not verified before routing, recording, or countersigning

- Severity: Critical
- Evidence file references:
  - `apps/hub/src/api/ws.ts:123-134` records `msg.signedState` and routes using separate `msg.htlc`, `msg.amount`, and `msg.paymentHash`.
  - `apps/hub/src/router.ts:79-97` computes outbound amount/expiry from request fields, not by proving the incoming signed state contains the matching HTLC.
  - `apps/hub/src/router.ts:157-164` records the outgoing recipient-settled state before settling the incoming HTLC from the original incoming state.
  - `apps/hub/src/channel-pool.ts:54-60` only checks version ordering before saving a state.
  - `packages/state-machine/src/signing.ts:181-190` provides signature verification helpers that the hub API path does not call.
  - `packages/state-machine/src/channel.ts:18-40` provides update validation helpers that the hub API path does not call.
- Observed behavior: `handlePay` accepts a caller-supplied signed state and a caller-supplied HTLC as independent values. It does not verify channel ID equality, channel party signatures, sender identity, balance conservation, `version == latest + 1`, HTLC inclusion, HTLC amount/paymentHash/expiry equality, or direction. `payDirect` and `closeRequest` also countersign arbitrary `msg.signedState.state` after only looking up `msg.channelId`.
- Impact: A malicious sender can provide an incoming signed state that does not lock their funds, while providing an HTLC object that causes the hub to lock/pay the outbound side. When the recipient settles, the hub records the outgoing settled state first and then fails to settle the missing inbound HTLC. This is a direct hub-loss path.
- Recommended fix: Add a single admission validator for every client-supplied `SignedState`: channel ID must match the route, both signatures must verify against channel parties and domain, previous/latest state must transition by an allowed state-machine operation, balances must be conserved, and the requested HTLC must be present exactly once with matching amount, direction, hash, and expiry. Do not record or countersign until validation passes.
- Tests/checks needed: Negative tests for mismatched channel ID, stale/skipped version, wrong signer, missing HTLC, mismatched HTLC amount/hash/expiry, malicious finalized state, and `payDirect`/`closeRequest` with pending HTLCs or non-conserved balances.

### H-02: WebSocket auth is disabled by default and envelope auth is not bound to message actor/channel

- Severity: Critical
- Evidence file references:
  - `apps/hub/src/config.ts:59-60` enables signed envelopes only when `HUB_REQUIRE_SIGNED_ENVELOPE === 'true'`.
  - `apps/hub/src/config.test.ts:5-12` asserts the default is `requireSignedEnvelope === false`.
  - `apps/hub/src/api/ws.ts:361-384` verifies an envelope only when required, then discards the recovered signer and dispatches the decoded message.
  - `apps/hub/src/auth/envelope.ts:64-78` only checks the signer is any known channel party and records the nonce.
  - `apps/hub/src/api/ws.ts:78-107` lets a message set `sessions[msg.address]` and receive that address's channels/pending HTLCs.
  - `apps/hub/src/api/ws.ts:216-280` accepts settle/fail by HTLC id without signer or channel binding.
- Observed behavior: With defaults, raw WebSocket messages are accepted. With envelopes enabled, any known channel party can sign an envelope for a payload that claims another address/channel. The verified signer is not passed into `dispatch` and no handler checks that the signer owns `msg.address`, is a party to `msg.channelId`, or is the intended recipient for `htlcSettle`/`htlcFail`.
- Impact: Attackers can impersonate subscribers, receive or suppress pending offers, trigger `htlcFail`, submit forged `htlcSettle` state, request countersignatures, or close arbitrary channels reachable by the hub. Combined with H-01/H-07, this can become fund loss, not only privacy leakage.
- Recommended fix: Make signed envelopes mandatory outside explicit local/dev mode. Change `verifyEnvelope`/dispatch to carry `{ signer, payload }` into handlers. Enforce per-message authorization: `subscribe.address == signer`, `pay/payDirect/closeRequest` signer is the non-hub party for that channel, and `htlcSettle/htlcFail` signer is the outbound recipient/channel party associated with the persisted route.
- Tests/checks needed: Integration tests with envelopes on and off; signer/address mismatch rejection; known signer attempting another user's subscribe/pay/settle/fail rejected; replay rejection remains intact.

### H-03: Production defaults start on mainnet with a known hub key and open operator REST API

- Severity: Critical
- Evidence file references:
  - `apps/hub/src/config.ts:37-44` defaults `CHAIN_ID` to Taiko mainnet and `HUB_PRIVATE_KEY` to `0x...0001`.
  - `apps/hub/src/config.ts:45-58` defaults RPC and contract addresses to mainnet values.
  - `apps/hub/.env.example:1-7` includes the known private key and omits `HUB_OPERATOR_TOKEN` and `HUB_REQUIRE_SIGNED_ENVELOPE`.
  - `apps/hub/src/api/index.ts:80-86` returns `true` for operator checks when `HUB_OPERATOR_TOKEN` is unset.
  - `apps/hub/src/api/index.ts:114-150` exposes channel listing and channel-open registration behind that optional operator check.
- Observed behavior: A default or copied `.env.example` deployment can run against mainnet RPC/contracts with a public private key, unsigned WebSocket messages, and unauthenticated operator REST routes.
- Impact: An internet-exposed hub can have arbitrary channels registered/listed and can sign states with a known, compromised key. Even if the key has no funded channels initially, this is an unsafe deployment posture for a fund-handling service.
- Recommended fix: Fail fast in non-test mode unless `HUB_PRIVATE_KEY`, `HUB_OPERATOR_TOKEN`, and signed-envelope auth are explicitly configured. Reject known development keys on non-`31337` chains. Move operator token into `HubConfig` and test `buildServer(env)` without mutating `process.env`.
- Tests/checks needed: Config tests that mainnet startup without explicit secret/auth throws; `.env.example` should use placeholders, not a real private key value.

### H-04: Outbound routing is not serialized atomically and can sign conflicting same-version states

- Severity: Critical
- Evidence file references:
  - `apps/hub/src/router.ts:99-125` reads the latest outgoing state, builds `version + 1`, and signs it.
  - `apps/hub/src/api/ws.ts:127-160` calls `router.route()`, records in-memory inflight, then records the outgoing state later.
  - `apps/hub/src/channel-pool.ts:54-60` locks only the final save and silently ignores states whose version is not greater than the current latest.
  - `apps/hub/src/mutex.ts:11-21` provides per-key locks, but the pay path does not hold an outgoing-channel lock across read-sign-save.
- Observed behavior: Two concurrent payments over the same outbound channel can both read the same latest state and both receive hub signatures for different `version + 1` states. The loser may be dropped by `recordState`, but its inflight entry/payment records/offers can already exist.
- Impact: The hub can equivocate by signing conflicting same-version states. This breaks channel safety assumptions and leaves local persistence inconsistent with signatures already sent to clients.
- Recommended fix: Serialize route construction and state persistence per outgoing channel, ideally with deterministic lock ordering for incoming/outgoing channel pairs. Add a DB-level optimistic compare-and-swap (`WHERE latest_version = expected`) or transaction around route read, signature, state insert, HTLC insert, payment insert, and outbox enqueue.
- Tests/checks needed: Concurrent `pay` test that fires two routes against the same outgoing channel and asserts versions are unique/sequential, no stale state is silently offered, and all DB rows match the accepted state.

### H-05: Payment lifecycle writes are non-atomic

- Severity: High
- Evidence file references:
  - `apps/hub/src/db/types.ts:3-8` exposes transaction support.
  - `apps/hub/src/api/ws.ts:159-190` writes router memory, outgoing state, two HTLC rows, one payment row, then liquidity reservation as separate operations.
  - `apps/hub/src/api/ws.ts:225-234` and `apps/hub/src/api/ws.ts:260-269` settle/fail via separate state, liquidity, HTLC, payment, and metrics writes.
  - `apps/hub/src/liquidity.ts:39-46` can throw on insufficient reservation, but `apps/hub/src/api/ws.ts:188-195` logs and continues after state advancement.
- Observed behavior: The DB transaction abstraction is not used for fund-state workflows. There is no durable outbox boundary between state mutation and WebSocket delivery.
- Impact: A crash or mid-sequence exception can produce durable states without HTLC/payment records, payment rows without matching channel state, stale liquidity reservations, or delivered offers that cannot be recovered.
- Recommended fix: Model payment transitions as one durable state machine. Use a DB transaction for accepted transition rows, state inserts, HTLC rows, payment rows, and an outbox event. Only send WebSocket messages after commit, and make retry/redelivery idempotent.
- Tests/checks needed: Fault-injection tests for each await in pay/settle/fail, then restart and assert recovery either completes or rolls back to a safe state.

### H-06: In-flight router state is not rehydrated after restart

- Severity: High
- Evidence file references:
  - `apps/hub/src/router.ts:61-62` stores route linkage only in in-memory maps.
  - `apps/hub/src/api/ws.ts:53-64` constructs a fresh router when WebSocket routes are registered.
  - `apps/hub/src/server.ts:43-47` hydrates channels/latest states and liquidity reservations only.
  - `apps/hub/src/liquidity.ts:77-86` rehydrates reservations from `htlcs`, not router route mappings.
  - `apps/hub/src/api/ws.ts:220-223` and `apps/hub/src/api/ws.ts:255-258` drop settle/fail messages when the in-memory map is missing.
- Observed behavior: The database can contain `htlcs.state = 'inflight'`, but after restart the router has no `incomingHtlcId -> outgoingHtlcId` mapping, no sender/recipient linkage, and no pending offer payloads.
- Impact: Recipients can no longer settle/fail in-flight payments after restart. Offline pending delivery is also lost because `pendingForRecipient` reads only router memory.
- Recommended fix: Persist the full route record: incoming/outgoing channel IDs, incoming/outgoing HTLC IDs, outgoing HTLC, incoming sender, recipient, signed states needed for recovery, created/expiry times, and keysend payload delivery metadata. Rebuild router pending maps at startup and resume timeout/fail logic.
- Tests/checks needed: End-to-end pay with recipient offline or pending, restart hub, subscribe/settle/fail, and assert the payment completes and DB rows converge.

### H-07: Settle/fail handlers remove in-flight state before validation and accept control messages by HTLC id

- Severity: High
- Evidence file references:
  - `apps/hub/src/router.ts:140-145` deletes in-flight entries in `takeByOutgoingId`.
  - `apps/hub/src/api/ws.ts:220-225` removes the entry before `settleIncoming`.
  - `apps/hub/src/router.ts:157-164` records the outgoing signed state before validating the incoming preimage against the incoming HTLC.
  - `apps/hub/src/api/ws.ts:251-269` lets `htlcFail` fail the incoming side without checking signer, channel ID, or recipient authority.
- Observed behavior: A malformed settle/fail can consume the in-memory route before the handler proves the preimage, verifies the recipient's signed state, or checks the message is from the route's recipient.
- Impact: A bad settle can strand a payment and possibly record a poisoned outgoing state. A forged fail can cancel someone else's payment if the attacker learns or guesses the outgoing HTLC id.
- Recommended fix: Add `peek` then validate, then atomically transition and delete. Bind settle/fail to the persisted route and authenticated signer. Verify recipient state signatures and expected version before recording any outgoing state.
- Tests/checks needed: Bad preimage must not delete in-flight state; wrong channel ID must reject; unauthorized signer must reject; duplicate settle/fail must be idempotent.

### H-08: Dispute handler can select an on-chain-invalid latest state

- Severity: High
- Evidence file references:
  - `apps/hub/src/dispute-handler.ts:90-112` selects `repos.states.latest(channelId)` only by version.
  - `apps/hub/src/dispute-handler.ts:163-167` submits that state to `dispute`.
  - `packages/sdk/src/chain-adapter.ts:67-80` encodes `htlcsRoot` from `state.htlcs`.
  - `packages/contracts/src/PaymentChannel.sol:239-245` requires `htlcsRoot == bytes32(0)` and a closer signature.
  - `packages/contracts/test/PaymentChannel.t.sol:411-421` tests that non-empty HTLC roots revert.
- Observed behavior: The handler does not check that the selected latest state is dispute-eligible: empty HTLC root, conserved balances, valid closer signature, and receipt success. It records `won` after `waitForTransactionReceipt` without inspecting receipt status; whether viem throws on all relevant reverted receipts should be verified.
- Impact: If the latest local state contains in-flight HTLCs, the dispute transaction will revert and the hub may miss the dispute window unless another clean newer state exists and is selected. This is especially dangerous because routing itself signs states with non-empty HTLC arrays.
- Recommended fix: Maintain a latest dispute-eligible fully signed state per channel, separate from transient HTLC states, or implement on-chain HTLC adjudication. Before submission, verify state eligibility and closer signature locally. Check receipt status/logs before marking `won`.
- Tests/checks needed: Dispute with latest state containing HTLCs must not mark won; handler should choose a valid newer empty state if available; reverted receipt must remain pending or lost with explicit reason.

### H-09: Chain watcher lacks historical catch-up and reorg proof

- Severity: High
- Evidence file references:
  - `apps/hub/src/chain-watcher.ts:66-77` initializes missing `chain_watcher.last_processed_block` to `head - 1` or `0` on RPC failure.
  - `apps/hub/src/chain-watcher.ts:90-102` persists only the safe block number after processing.
  - `apps/hub/src/chain-watcher.ts:122-187` fetches each event type over the whole range in one RPC call and stores no block hashes.
  - `apps/hub/src/chain-watcher.ts:143-155` dispute handling depends on observing `ChannelClosingUnilateral`.
- Observed behavior: A fresh/rehydrated DB with active channels but no watcher checkpoint will skip historical events before `head - 1`. The checkpoint cannot detect deep reorgs because it stores no block hash. Long downtime creates large `getLogs` ranges without chunking/backoff beyond retrying the whole poll.
- Impact: Missing a unilateral close event can mean no dispute response. Reorged finality or failed large-range queries can leave channel statuses and dispute records stale.
- Recommended fix: Initialize from a configured deployment/start block, or from each channel's open block, not current head. Persist `{blockNumber, blockHash}` and rewind on mismatch. Chunk log scans, store per-event cursors or idempotency keys, and expose watcher lag/error metrics.
- Tests/checks needed: Catch-up from old checkpoint, missing checkpoint with existing active channel, simulated reorg, large-range chunking, and RPC failure/retry without advancing cursor.

### H-10: HTLC fee math does not match SDK expectations

- Severity: Medium
- Evidence file references:
  - `apps/hub/src/fee-policy.ts:7-15` charges `amount * bps / 10000 + flat`.
  - `apps/hub/src/router.ts:79-95` treats `req.amount` as the incoming amount and forwards `req.amount - fee`.
  - `packages/sdk/src/client.ts:98-100` defaults SDK hub fees to zero.
  - `packages/sdk/src/client.ts:505-570` computes `totalAmount = baseAmount + fee(baseAmount)` and sends `amount: totalAmount`.
  - `packages/sdk/src/client.ts:301-305` recipients fail invoice HTLCs when `invoice.amount > msg.htlc.amount`.
  - `packages/protocol/src/constants.ts:55-58` sets protocol defaults to `DEFAULT_HUB_FEE_BPS = 10n` and `DEFAULT_HUB_FEE_FLAT = 1n`.
- Observed behavior: Unless the SDK is configured with the same fee settings as the hub, a default SDK sends no hub fee while the default hub subtracts one. Even when configured, adding `fee(base)` is not always the same as grossing up so that `amount - fee(amount) >= base`.
- Impact: Routed invoice payments can underpay and be failed by recipients, or clients may lock more/less than expected. This is not necessarily theft by itself, but it is a payment correctness and UX blocker.
- Recommended fix: Add a fee quote/version endpoint or include fee policy in authenticated subscribe/channel metadata. SDK should use the hub-provided fee schedule and gross-up formula, and the hub should reject `pay` when the incoming HTLC amount does not match the declared amount and expected policy.
- Tests/checks needed: Cross-package fee fixtures for zero fee, flat fee, bps fee, flat+bps, rounding boundaries, and invoice amount received exactly.

### H-11: Liquidity tracker is not authoritative

- Severity: Medium
- Evidence file references:
  - `apps/hub/src/liquidity.ts:21-46` has explicit `set` and reservation methods.
  - `apps/hub/src/server.ts:46-47` hydrates only reservations from HTLC rows.
  - `apps/hub/src/api/ws.ts:188-195` logs and continues if reservation fails after state advancement.
  - `apps/hub/src/router.ts:104-111` gates outbound routing on the latest channel balance, not `liquidity.availableOutbound`.
  - `rg` inspection found no production call to `liquidity.set(...)` outside tests.
- Observed behavior: Liquidity snapshots are not populated from channel states, on-chain opens, or latest balances. Reservation failures do not abort routing once the outgoing state has been advanced.
- Impact: Liquidity metrics can report zero or stale values, and reservations do not prevent oversubscription under concurrency. The actual protection is the router's latest balance check, which is itself race-prone per H-04.
- Recommended fix: Derive liquidity from validated latest states and persisted in-flight reservations in one place. Make reservation part of the same accepted routing transaction, and abort before signing if availability is insufficient.
- Tests/checks needed: Startup liquidity from existing states, state update adjusts liquidity, concurrent reservations cannot exceed available outbound, metrics match DB state.

### H-12: DB schema and repository methods do not enforce enough integrity

- Severity: Medium
- Evidence file references:
  - `apps/hub/migrations/001_initial.sql:1-92` defines tables without foreign keys, status CHECK constraints, amount non-negativity checks, or route uniqueness constraints beyond primary IDs.
  - `apps/hub/src/db/repos/htlc-repo.ts:95-101`, `apps/hub/src/db/repos/payment-repo.ts:105-121`, and `apps/hub/src/db/repos/dispute-repo.ts:53-69` do not check whether UPDATE matched a row.
  - `apps/hub/src/db/repos/state-repo.ts:85-103` checks latest version in application code, not via a transactional DB invariant.
- Observed behavior: Invalid lifecycle strings, orphan HTLC/payment rows, no-op updates, and stale state inserts can be silently accepted or ignored depending on path.
- Impact: Recovery and monitoring become unreliable after partial failures or bugs. A payment can appear settled/failed in one table but not another.
- Recommended fix: Add CHECK constraints for enum columns, foreign keys for channel/payment/HTLC relationships, route-level uniqueness for incoming/outgoing HTLC pairs, and repository errors on unexpected zero-row updates. Consider a single `payment_routes` table as the source of truth.
- Tests/checks needed: Migration tests for constraints, repo tests that no-op updates throw, and crash recovery checks that DB invariants hold.

### H-13: Metrics/config are not production-safe

- Severity: Low
- Evidence file references:
  - `apps/hub/src/config.ts:55` parses `prometheusPort`.
  - `apps/hub/src/server.ts:88-97` serves `/metrics` on the main Fastify app rather than a separate port.
  - `apps/hub/src/metrics.ts:75-80` casts BigInt liquidity to `Number`.
- Observed behavior: `PROMETHEUS_PORT` is configured but not used. `/metrics` is unauthenticated on the public app server. Liquidity values can lose precision when converted to `Number`.
- Impact: Metrics can leak operational/fund information and can be misleading for large balances.
- Recommended fix: Either bind metrics to the configured port/interface or remove the setting. Restrict metrics to private networks or operator auth. Export base-unit strings or safe numeric gauges with explicit bounds.
- Tests/checks needed: Config test that metrics binds as intended; metrics auth/network exposure test; precision boundary test.

## Readiness blockers

- Blocker: Require and bind authenticated WebSocket envelopes before any mainnet use.
- Blocker: Fail startup on mainnet without explicit non-default hub key, operator token, and signed-envelope auth.
- Blocker: Validate every incoming signed state and HTLC transition before recording, routing, or countersigning.
- Blocker: Serialize and atomically persist routing transitions; prevent conflicting same-version outbound signatures.
- Blocker: Persist and rehydrate full in-flight route state, including recovery/redelivery behavior.
- Blocker: Make dispute response select only on-chain-valid, fully signed, empty-HTLC states or add HTLC adjudication support.
- Blocker: Add chain watcher catch-up/reorg handling sufficient for dispute-window safety.

## Validation notes

- Ran read-only source inspection with `rg`, `sed`, and `nl` across `apps/hub`, SDK/state-machine/contract files used by the hub.
- Ran `pnpm --filter @tainnel/hub test`. It failed before most suites executed because Vite could not resolve workspace package entries for `@tainnel/sdk` and `@tainnel/protocol`; those package manifests export `./dist/*`, but no `dist` directories are present. I did not run package builds because that would create/modify files outside this requested report.
- Confirmed `git status --short` was clean before writing this report. The only intended changed file is `deepseek_audit_report_hub.md`.
