# P5 — Hub

**Status:** 🟡 partial — first cut landed: sqlite persistence + repos, channel
pool with per-channel mutex, liquidity reservations, fee policy, real
`viem.watchContractEvent` chain-watcher, dispute handler that calls `dispute()`
on PaymentChannel, WebSocket protocol matching the SDK wire shapes
(subscribe / pay / close.request / ping), REST endpoints (/health,
/v1/channels, /v1/channels/open, /v1/payments, /v1/preimages) gated by bearer
token, six custom Prometheus metrics, and an integration test exercising the
full happy-path WS protocol against the real Fastify server. 26 hub tests pass.
Still TODO before 🟢: signed-envelope auth (D5.2), router work for true
hub→hub forwarding, anvil-backed integration test, coverage gate.
**Blocks:** P8, P10
**Effort:** ~1.5 weeks (the longest sub-project)
**Depends on:** P3 (state machine), P4 (SDK message shapes), P2 (deployed contracts on Hoodi)
**Parallelizable with:** P6 (watchtower) and P7 (CLI)

## Decisions

### D5.1 Database driver in production
- **Default:** **sqlite** + [litestream](https://litestream.io/) replicating to
  S3-compatible storage (Cloudflare R2 free tier is fine)
- **Tradeoff:** sqlite is one binary, no separate process; perfect for a single-hub
  dogfood. Postgres pays off only when you scale to multiple hub instances, which
  isn't on the roadmap.
- Decision: ☑ sqlite + litestream ☐ Postgres ☐ sqlite without backup

### D5.2 WebSocket auth
- **Default:** every WS message from a client carries a fresh signed envelope
  `{nonce, ts, payload, sig}` where `sig` is over `keccak256(nonce || ts || payload)`.
  Hub rejects if `nonce` already seen, `ts` outside ±60s, or sig doesn't recover to a
  known channel party.
- **Tradeoff:** session tokens are simpler but require expiry/rotation. Per-message
  auth is stateless and survives reconnection; we already have signing infra.
- Decision: ☑ per-message signed envelope ☐ session token

### D5.3 Hub key management
- **Default:** hot key on the server; balance kept low (only what's needed for
  one channel-fund's worth of inbound liquidity + gas). Earnings periodically swept
  to a cold address.
- **For dogfood:** acceptable. See [`09-ops.md`](./09-ops.md) for sweep automation.
- Decision: ☑ hot wallet (default) ☐ remote signer (e.g., AWS KMS) — overkill for v1

### D5.4 Channel acceptance policy
- **Default:** any address can request to open a channel; hub auto-accepts if its
  USDC liquidity allows. Caps: max 100 USDC per counterparty, max 10 channels total
  for v1.
- **Why it matters:** prevents a single user from draining hub liquidity.
- Decision: ☑ accept default ☐ allowlist ☐ unlimited

## Implementation tasks

### Persistence layer (`src/db/`)
- [x] `[agent]` Migrations: `migrations.ts` with tables `channels`,
      `signed_states`, `htlcs`, `payments`, `seen_nonces`, `disputes`. Idempotent,
      driven by a `_schema_migrations` table. Runs on startup.
- [x] `[agent]` `SqliteDatabase` real impl using `better-sqlite3`. Prepared
      statements for hot paths.
- [ ] `[agent]` `PostgresDatabase` real impl using `pg`. **Skipped for v1**: stub
      throws "postgres not implemented for v1; use sqlite". sqlite + litestream
      is the dogfood path (D5.1) — postgres is a phase-2 follow-up.
- [x] `[agent]` Repository abstraction: `ChannelRepo`, `StateRepo`, `HtlcRepo`,
      `PaymentRepo`, `NonceRepo`, `DisputeRepo`. One method = one query.

### `channel-pool.ts`
- [x] `[agent]` Persist on `register`. `hydrate()` rebuilds from DB on startup.
- [x] `[agent]` `recordState`: rejects with `StaleStateError` if `version <=` known.
- [x] `[agent]` Concurrency: per-channel async mutex via `withLock` (chained
      promise map). Test asserts serialized order on concurrent ops.

### `router.ts` — the actual 1-hop routing engine
- [x] `[agent]` `route(req)`: validates source/dest channels are open, reserves
      outbound liquidity, looks up preimage in `PreimageRegistry`, returns
      `{outgoingHtlc, preimage, feePaid}` or throws typed errors
      (`ChannelNotOpenError`, `InsufficientLiquidityError`, `UnknownPaymentHashError`).
- [ ] `[agent]` Expiry buffer math + multi-step persistence are not yet wired —
      v1 dogfood treats the hub as the payee (knows the preimage). True hub→hub
      forwarding lands as a follow-up.
- [x] `[agent]` Failure modes: each returns a typed error.
- [ ] `[agent]` Idempotency on duplicate HTLC `id`: deferred — relies on DB
      primary-key constraint at the `htlcs` table for now.

### `liquidity.ts`
- [x] `[agent]` `reserveOutbound(channelId, amount)` and
      `releaseReservation(channelId, amount)` plus `availableOutbound` and
      `InsufficientLiquidityError`.
- [x] `[agent]` `hydrateFromHtlcs(channelId, htlcRepo)` sums pending HTLCs.

### `chain-watcher.ts`
- [x] `[agent]` Real `viem.watchContractEvent` on the four deployed
      `PaymentChannel` events. Inline ABI in the file.
- [x] `[agent]` On `channelOpened`, transitions channel `pending` → `open`.
- [x] `[agent]` On `closingUnilateral`, hands off to `dispute-handler`.
- [x] `[agent]` Reorg buffer: holds events until `currentBlock - firstSeenBlock
      >= 3` (configurable).

### `dispute-handler.ts`
- [x] `[agent]` Fetches `stateRepo.latest(channelId)`. If newer, encodes the
      `Adjudicator.ChannelState` ABI tuple and calls `dispute(channelId, state,
      sigCloser)` via `viem.walletClient.sendTransaction`.
- [x] `[agent]` Persists `disputeRepo.record(...)` then
      `disputeRepo.markResponded(channelId, txHash)`.
- [x] `[agent]` If our state is older or equal, logs loudly via
      `logger.error` and persists the observation as a pending dispute row.

### REST + WebSocket API (`src/api/`)
- [x] `[agent]` `GET /health` — returns `{status, dbReady, chainReady}`. DB ping
      via `channelRepo.list()`. Chain ping via `pingChain()` with a 2s timeout.
- [x] `[agent]` `GET /v1/channels` — bearer-auth gated.
- [x] `[agent]` `POST /v1/channels/open` — records pending row, returns
      `{channelId, status: 'pending'}`.
- [x] `[agent]` `POST /v1/payments` — accepts a wrapped `{ msg }` body and runs
      the same WS handler.
- [x] `[agent]` `WS /v1/ws` — bidirectional. Handles `subscribe` /
      `subscribe.ack`, `pay` / `payment.settle` / `payment.fail`, `close.request`
      / `close.counter` / `close.reject`, `ping` / `pong`. Wire shapes match
      `packages/test-utils/src/mock-hub.ts` byte-for-byte. Verified by an
      integration test that uses the SDK's `WebSocketTransport` against the
      live Fastify server.
- [x] `[agent]` `POST /v1/preimages` — bearer-auth gated; lets the hub operator
      seed paymentHash → preimage so the hub can settle pay messages.

### Auth (D5.2 implementation)
- [ ] `[agent]` Signed envelope verification. **Deferred**: the wire handler
      already accepts a bare `{id, kind, payload}` (matching the mock hub).
      Wrapping with `{nonce, ts, payload, sig}` is a follow-up. The
      `seen_nonces` table is in place so the auth layer can drop in cleanly.

### Operational details
- [x] `[agent]` `/metrics` Prometheus endpoint: `tainnel_hub_channels_total`,
      `tainnel_hub_payments_total{status}`, `tainnel_hub_htlcs_in_flight`,
      `tainnel_hub_inbound_liquidity_usdc`, `tainnel_hub_outbound_liquidity_usdc`,
      `tainnel_hub_disputes_total`.
- [x] `[agent]` Structured pino logs at every state transition, payment,
      dispute, and chain event.
- [ ] `[agent]` Graceful shutdown: `app.addHook('onClose', ...)` stops the
      chain watcher and closes the DB. WS draining with code 1001 is
      a follow-up — Fastify closes the socket on `app.close()` already, but
      explicit drain isn't yet wired.

### Tests
- [ ] `[agent]` Integration tests using a real anvil + deployed contracts.
      **Deferred to P10 launch infra.** The current integration test runs
      against a real Fastify+ws server but mocks the chain. Marked `// TODO P10`.
- [ ] `[agent]` Coverage ≥ 70% lines. Vitest threshold enforced; current
      coverage not measured numerically. To run with coverage:
      `pnpm --filter @tainnel/hub test --coverage`.

## `[review]` gates

- You read `router.ts` end to end. This is the most subtle file in the codebase —
  the expiry-buffer math is where bugs hide.
- You read `dispute-handler.ts`. Stale-state detection bugs lose money.
- You read the migrations file. Schema changes after launch are painful.

## Done when

- Coverage ≥ 70% lines on hub
- `pnpm --filter @tainnel/hub dev` boots locally against an anvil + deployed
  contracts and accepts a manual channel via the CLI
- An end-to-end "register-pay-settle" loop works locally
- Branch merged with `feat(hub): implement routing, persistence, dispute handling`
