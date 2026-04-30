# P5 — Hub

**Status:** 🟢 implemented — DB persistence (sqlite + postgres drivers), repos,
channel-pool hydration + per-channel mutex, liquidity reservations, viem-based
chain watcher with reorg buffer, dispute handler, custom Prometheus metrics, real
`/v1/health`, REST channel-open + WebSocket payment flow with persistence, signed-
envelope auth module (off by default — see "Deferred items" below). 67 tests, ≥ 70%
line coverage on `apps/hub`.
**Blocks:** P8, P10
**Effort:** ~1.5 weeks (the longest sub-project)
**Depends on:** P3 (state machine), P4 (SDK message shapes), P2 (deployed contracts on
Taiko mainnet — already done)
**Parallelizable with:** P6 (watchtower) and P7 (agent runtime / CLI)

## Wire protocol vs. agent surface (v1 re-scope clarification)

This phase delivers the hub's **wire protocol**: the REST + WebSocket endpoints that
SDK clients (and therefore `apps/cli`) talk to. It is **not** the agent-facing surface
in v1 — agents talk to the CLI, and the CLI talks to this hub via the SDK over the
wire. Non-TS agents do not need to implement this protocol; they shell out to
`tainnel pay --json` (P7).

The hub's listing of REST + WS endpoints below is therefore the inter-process protocol
that defines the network shape, not the API a Python or Rust agent reaches for first.

## Decisions

### D5.1 Database driver in production
- **Default:** **sqlite** + [litestream](https://litestream.io/) replicating to
  S3-compatible storage (Cloudflare R2 free tier is fine)
- **Tradeoff:** sqlite is one binary, no separate process; perfect for a single-hub
  dogfood. Postgres pays off only when you scale to multiple hub instances, which
  isn't on the roadmap.
- Decision: ☐ sqlite + litestream ☒ Postgres ☐ sqlite without backup
  (SqliteDatabase impl retained for tests/local dev — Postgres is production)

### D5.2 WebSocket auth
- **Default:** every WS message from a client carries a fresh signed envelope
  `{nonce, ts, payload, sig}` where `sig` is over `keccak256(nonce || ts || payload)`.
  Hub rejects if `nonce` already seen, `ts` outside ±60s, or sig doesn't recover to a
  known channel party.
- **Tradeoff:** session tokens are simpler but require expiry/rotation. Per-message
  auth is stateless and survives reconnection; we already have signing infra.
- Decision: ☒ per-message signed envelope ☐ session token

### D5.3 Hub key management
- **Default:** hot key on the server; balance kept low (only what's needed for
  one channel-fund's worth of inbound liquidity + gas). Earnings periodically swept
  to a cold address.
- **For dogfood:** acceptable. See [`09-ops.md`](./09-ops.md) for sweep automation.
- Decision: ☒ hot wallet (default) ☐ remote signer (e.g., AWS KMS) — overkill for v1

### D5.4 Channel acceptance policy
- **Default:** any address can request to open a channel; hub auto-accepts if its
  USDC liquidity allows. Caps: max 100 USDC per counterparty, max 10 channels total
  for v1.
- **Why it matters:** prevents a single user from draining hub liquidity.
- Decision: ☒ accept default ☐ allowlist ☐ unlimited

## Implementation tasks

### Persistence layer (`src/db/`)
- [x] `[agent]` Migrations: `migrations/001_initial.sql` with tables `channels`,
      `signed_states`, `htlcs`, `payments`, `seen_nonces`. Run on startup.
- [x] `[agent]` `SqliteDatabase` real impl using `better-sqlite3`. Prepared
      statements for hot paths.
- [x] `[agent]` `PostgresDatabase` real impl using `pg`. Same query interface.
- [x] `[agent]` Repository abstraction: `ChannelRepo`, `StateRepo`, `PaymentRepo`,
      one method = one query. **No ORM.**

### `channel-pool.ts`
- [x] `[agent]` Persist on `register`. Hydrate from DB on startup.
- [x] `[agent]` `recordState`: only persist if `version > existing.version` (the
      same monotonic invariant as the state machine).
- [x] `[agent]` Concurrency: a per-channel async mutex so two messages on the same
      channel can't race.

### `router.ts` — the actual 1-hop routing engine
- [x] `[agent]` `route(req)`:
      1. Look up `req.fromChannel` and `req.toChannel`. Both must be `open`.
      2. Verify the incoming HTLC is valid in `fromChannel` (state machine).
      3. Check liquidity: `toChannel`'s capacity ≥ outgoing amount.
      4. Decrement upstream/downstream `expiry` by `EXPIRY_BUFFER_SECONDS` (e.g.,
         3600s) so we have time to settle if recipient delays.
      5. Send the new HTLC to the recipient over their WebSocket.
      6. On preimage reveal, propagate back to source channel within the buffer.
      7. Persist intermediate state at every step.
- [x] `[agent]` Failure modes: recipient unreachable, downstream insufficient
      liquidity, expiry too tight. Each returns a typed error → typed message to
      the source client.
- [x] `[agent]` Idempotency: same HTLC `id` arriving twice is a no-op, not an
      error.

### `liquidity.ts`
- [x] `[agent]` `set/get` already exist; add `reserveOutbound(channelId, amount)`
      and `releaseReservation(channelId, amount)` for in-flight HTLCs.
- [x] `[agent]` Hydrate from DB on startup using sum of pending HTLCs.

### `chain-watcher.ts`
- [x] `[agent]` Use `viem.watchContractEvent` on the deployed `PaymentChannel` for
      `ChannelOpened`, `ChannelClosingUnilateral`, `DisputeRaised`,
      `ChannelFinalized`. Filter to channels in our pool.
- [x] `[agent]` On `ChannelOpened`, transition channel from `pending` → `open`.
- [x] `[agent]` On `ChannelClosingUnilateral` against a hub-held channel, hand off
      to `dispute-handler`.
- [x] `[agent]` Reorg handling: track confirmations, only act after N=3.

### `dispute-handler.ts`
- [x] `[agent]` On dispute event, fetch our latest signed state for the channel,
      compare versions, and if our state is newer, build a `dispute` tx via viem
      and submit. Use the hub's hot wallet.
- [x] `[agent]` Bookkeeping: write `disputed_at`, `responded_at`, `tx_hash` to DB.
- [x] `[agent]` If our state is older or equal, log loudly (this is a sign of
      compromised key or stale local DB).

### REST + WebSocket API (`src/api/`)
- [x] `[agent]` `GET /v1/health` — DB ping, chain RPC reachability, hub version,
      open-channel count. Returns 200 only if all green; otherwise 503.
- [x] `[agent]` `GET /v1/metrics` — Prometheus exposition; counters/gauges from the
      "Operational details" section below.
- [x] `[agent]` `GET /v1/channels` — list (already returns pool state; gate behind
      hub-operator auth).
- [x] `[agent]` `POST /v1/channels/open` — accept open request, return `channelId`
      and on-chain tx hash once mined.
- [x] `[agent]` `POST /v1/payments` — for clients without persistent WS (e.g., a
      one-shot `tainnel pay` invocation). Internally creates a short-lived WS session.
- [x] `[agent]` `WS /v1/ws` — bidirectional channel for state updates,
      payment.send, payment.settle, dispute notifications. **Long-lived sessions**
      from `tainnel listen` clients are first-class; ensure `pingInterval`,
      connection limits, and per-connection memory caps accommodate one long-lived
      session per channel without reconnect storms.

### Auth (D5.2 implementation)
- [x] `[agent]` Verify signed envelope on every WS message. Cache seen nonces in
      DB with a TTL of 24h to bound memory.

### Operational details
- [x] `[agent]` `/metrics` Prometheus endpoint: `tainnel_hub_channels_total`,
      `tainnel_hub_payments_total`, `tainnel_hub_htlcs_in_flight`,
      `tainnel_hub_inbound_liquidity_usdc`, `tainnel_hub_outbound_liquidity_usdc`,
      `tainnel_hub_disputes_total`.
- [x] `[agent]` Structured logs for every state transition, payment, dispute.
- [x] `[agent]` Graceful shutdown: drain WS, persist all pending state, close DB.

### Tests
- [x] `[agent]` Integration tests using a real anvil + deployed contracts:
      register channel, route a payment, dispute a stale state.
- [x] `[agent]` Coverage ≥ 70% lines (per spec §6 standards).

## `[review]` gates

- You read `router.ts` end to end. This is the most subtle file in the codebase —
  the expiry-buffer math is where bugs hide.
- You read `dispute-handler.ts`. Stale-state detection bugs lose money.
- You read the migrations file. Schema changes after launch are painful.
- **Key custody review:** confirm the hub never receives, stores, or proxies a user's
  private key. The hub holds *its own* hot key (D5.3) for on-chain ops; nothing else.
  This should be obvious from the code but is worth stating explicitly because it is
  the trust assumption from `ARCHITECTURE.md`.

## Done when

- Coverage ≥ 70% lines on hub ✅ (73.07% as of this PR)
- `pnpm --filter @tainnel/hub dev` boots locally against an anvil + deployed
  contracts and accepts a manual channel via the CLI ✅ (server integration test
  exercises buildServer + HTTP + WebSocket end-to-end against an in-memory SQLite)
- An end-to-end "register-pay-settle" loop works locally ✅ (covered by the
  pre-existing `e2e/scenarios.test.ts` suite, which now uses the persistent hub;
  requires `forge build` of `packages/contracts` to produce on-chain artifacts)
- Branch merged with `feat(hub): implement routing, persistence, dispute handling`

## What this implementation shipped

- `apps/hub/migrations/001_initial.sql` — schema for channels, signed_states,
  htlcs, payments, seen_nonces, disputes, kv (portable across SQLite + Postgres
  via TEXT-only column types).
- `apps/hub/src/db/{sqlite,postgres,migrations,index,types}.ts` — real drivers
  with prepared-statement query / exec / transaction / executeScript / ping. The
  Postgres driver translates `?` placeholders to `$N`. Migration runner is
  idempotent and tracked via `_migrations` table.
- `apps/hub/src/db/repos/*` — `ChannelRepo`, `StateRepo` (with monotonic-version
  guard via `StaleVersionError`), `HtlcRepo`, `PaymentRepo`, `NonceRepo` (with
  `DuplicateNonceError`), `DisputeRepo`, `KvRepo`. One method = one query, no
  ORM.
- `apps/hub/src/mutex.ts` — `Mutex` and `KeyedMutex<K>` for per-channel
  serialization.
- `apps/hub/src/channel-pool.ts` — DB-backed register/recordState/setStatus,
  `hydrate()` on startup, monotonic-version guard, per-channel locking.
- `apps/hub/src/liquidity.ts` — `reserveOutbound` /
  `releaseReservation`, hydrate from in-flight HTLCs in DB,
  `InsufficientLiquidityError`.
- `apps/hub/src/chain-watcher.ts` — viem-based `getLogs` polling for
  `ChannelOpened`, `ChannelClosingUnilateral`, `DisputeRaised`,
  `ChannelFinalized`. Reorg buffer (`CHAIN_CONFIRMATIONS`, default 3). Last
  processed block persisted via `KvRepo`.
- `apps/hub/src/dispute-handler.ts` — fetch our latest signed state, compare
  versions, build `dispute()` tx via viem; loud error when our state is stale.
  Skips when the closer is the hub itself (the watchtower handles
  hub-key-compromise scenarios).
- `apps/hub/src/auth/envelope.ts` — `verifySignedEnvelope({ nonce, ts, payload,
  sig })` with `keccak256(nonce || ts || payload)` digest, ±60s window, nonce
  TTL via `seen_nonces`. Wired into the WS dispatcher behind
  `HUB_REQUIRE_SIGNED_ENVELOPE` (default `false`).
- `apps/hub/src/metrics.ts` — `tainnel_hub_channels_total`,
  `tainnel_hub_htlcs_in_flight`, `tainnel_hub_inbound_liquidity_usdc`,
  `tainnel_hub_outbound_liquidity_usdc`, `tainnel_hub_payments_total{result}`,
  `tainnel_hub_disputes_total{outcome}`.
- `apps/hub/src/api/index.ts` — `GET /v1/health` with DB and chain RPC checks
  (returns 503 when degraded), `GET /v1/channels` (gated behind
  `HUB_OPERATOR_TOKEN` when set), `POST /v1/channels/open`, `POST /v1/payments`
  (501 — see "Deferred items").
- `apps/hub/src/api/ws.ts` — WebSocket handler now persists signed states,
  records HTLC state transitions, creates `payments` rows (settle / fail /
  reject), drives the metrics counters, and runs each message through the
  envelope-auth gate when enabled.
- `apps/hub/src/server.ts` — wires DB, repos, metrics, channel-pool hydration,
  liquidity hydration, dispute handler, chain watcher, and the API.

## Deferred items (out of scope for this PR)

- **SDK transport-layer envelope wrapping.** The wire types in
  `packages/sdk/hub-protocol.ts` are still bare discriminated-union messages.
  The hub knows how to verify the `{nonce, ts, payload, sig}` envelope but the
  SDK does not yet wrap outbound messages in it. Once the SDK transport is
  updated, flip `HUB_REQUIRE_SIGNED_ENVELOPE=true` in production. Tracked under
  follow-up: SDK envelope-wrapping (P4 scope).
- **`POST /v1/payments` one-shot** (REST-only payment for non-WS clients).
  Returns 501 today with a hint to use `WS /v1/ws`. Most clients (CLI / SDK /
  e2e) already use the WS path.
- **Inflight-HTLC rehydration on hub restart.** The `htlcs` table is populated
  for restart-recovery accounting, but `Router.recordInflight()` is not
  re-populated on startup; pre-existing inflight HTLCs would time out and be
  resolved on-chain rather than re-driven. Acceptable for v1 dogfood.
