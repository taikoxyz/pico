# P4 — SDK

**Status:** ✅ done — all storage adapters (Memory, File, IndexedDB),
transport (WebSocket + InMemory pipe + request/reply + backoff + heartbeat),
both wallet adapters (Viem, Browser/EIP-1193), `ChannelClient.open/pay/close/
list/getBalance/waitForFinalized` are implemented and exercised by 105 SDK
tests + 3 mock-hub round-trip tests. Pay timeout triggers a local
`failHtlc` fallback. Real-WebSocket `startMockHub` ships in
`@tainnel/test-utils`. End-to-end runnable example at
`examples/sdk-mock-flow.ts`. Coverage 92% lines (gate ≥80%).
**Blocks:** P5 (hub WebSocket protocol depends on SDK message shapes), P7 (wallet UI)
**Effort:** ~1 week
**Depends on:** P3 (state machine real, esp. `signing.ts`)

## Decisions

### D4.1 Default storage adapter per environment
- **Default:** browser → IndexedDB; Node → file
- Decision: ✅ accept default — `IndexedDBStorage` and `FileStorage` ship; consumers
  may still pass `MemoryStorage` for ephemeral tests/examples.

### D4.2 Reconnect/backoff policy for `WebSocketTransport`
- **Default:** exponential backoff 200ms → 30s, infinite retry, jittered
- Decision: ✅ accept default. `maxReconnects` remains available as an opt-in for
  callers that want a hard cap (used by tests).

### D4.3 Persistence safety
- **Default:** every state update is persisted **before** sending the signature
  to the hub. If we sign then crash, the next process startup must find the new
  state on disk and resume.
- **Why it matters:** if the hub gets a signature but our local store doesn't have
  the corresponding state, the hub can later post that state on-chain and we can't
  challenge.
- Decision: ✅ persist-before-send. Enforced in `ChannelClient.pay` and verified by
  the `persist-before-send` regression test in `client.test.ts`.

## Implementation tasks

### Transport
- [x] `[agent]` `WebSocketTransport.connect/close/send` — real implementation using
      browser-and-Node-compatible `ws` (use `WebSocket` global if available, else
      dynamically import `ws`).
- [x] `[agent]` Backoff per D4.2.
- [x] `[agent]` Message framing: every message is JSON with `{id, kind, payload}`.
      `id` is a UUID. The transport keeps a `Map<id, deferred>` for request/response
      pairs.
- [x] `[agent]` Heartbeat ping every 30s; reconnect if 2 missed.
- [x] `[agent]` `NostrRelayTransport` — leave as stub (Phase-2). Don't delete; just
      make sure the interface compiles.

### Storage
- [x] `[agent]` `MemoryStorage` already exists; add `delete`, `clear`.
- [x] `[agent]` `IndexedDBStorage` (browser): use a tiny wrapper, not Dexie or idb,
      to keep the bundle small.
- [x] `[agent]` `FileStorage` (Node): atomic-rename pattern (`write tmp → rename`),
      JSON encoding. Per-channel file under `${root}/channels/${id}.json`.

### Wallet adapter
- [x] `[agent]` `ViemWalletAdapter` wrapping a viem `WalletClient` from
      `createWalletClient(...)`. Uses `signTypedData` directly.
- [x] `[agent]` `BrowserWalletAdapter` wrapping `window.ethereum` (EIP-1193) for
      browsers that don't ship a connected wagmi client. The wallet UI will use
      wagmi's hook output instead, but the SDK should be usable from a plain page.
- [x] `[agent]` Document in README that the wallet adapter must be the **same
      address** as one of the channel's parties; otherwise sigs will fail.

### `ChannelClient.open(args)`
- [x] `[agent]` Build the on-chain `openChannel` tx using viem; sign with the
      wallet adapter; submit; wait for `ChannelOpened` event.
- [x] `[agent]` Persist the new `Channel` (status `pending` → `open` after event).
- [x] `[agent]` Establish a WebSocket session with the hub; send a `subscribe`
      message; await ack.

### `ChannelClient.pay(request)`
- [x] `[agent]` Generate preimage (32 random bytes), hash it, build an `Htlc`.
- [x] `[agent]` Apply locally via `state-machine.addHtlc`; sign new state.
- [x] `[agent]` **Persist before send** (D4.3).
- [x] `[agent]` Send `pay` message to hub with state + sig + paymentHash + amount +
      recipient.
- [x] `[agent]` Await `payment.settle` from hub with the preimage; verify it matches
      `paymentHash`; apply `settleHtlc` locally; sign settled state; persist.
- [x] `[agent]` Timeout handling: if hub doesn't settle within
      `htlc.expiry - safetyMargin`, fail locally and broadcast a `failHtlc` update.

### `ChannelClient.close(id, opts)`
- [x] `[agent]` Cooperative path: send `close.request` to hub with our latest
      signed state; await hub's counter-signed close-state; submit
      `closeCooperative` tx.
- [x] `[agent]` If hub doesn't respond in 60s, fall back to `closeUnilateral` with
      the latest signed state we have.
- [x] `[agent]` Listen for `ChannelFinalized` event. **Note:** cooperative
      close is final on receipt — `close()` returns with status `closed`.
      Unilateral close opens a dispute window (hours), so `close()` returns
      after the unilateral tx is mined; callers may then `await
      client.waitForFinalized(id)` to block on the on-chain event.

### `ChannelClient.list()`
- [x] `[agent]` Already half-implemented; expose `getBalance(id)` returning
      `(balanceUs, balanceCounterparty, pendingHtlcsTotal)`.

### Tests
- [x] `[agent]` Unit tests with a mock `Transport` (in-memory pipe), mock wallet
      adapter, mock storage. Cover open/pay/close happy paths.
- [x] `[agent]` Persistence-survives-crash test: simulate a crash between sign-and-
      send; reload; assert state machine is sane and we can recover.

## Quickstart example

- [x] `[agent]` `packages/sdk/README.md` quickstart should be runnable against a
      mock hub from `@tainnel/test-utils`. Include:
      ```ts
      import { ChannelClient, MemoryStorage, ... } from '@tainnel/sdk';
      // ... 20 lines that open, pay, close ...
      ```
- [x] `[agent]` Add `examples/sdk-mock-flow.ts` exercising the quickstart end-to-end.

## `[review]` gates

- You read the persist-before-send code path in `pay()`. This is the single most
  safety-critical line in the SDK.
- You skim the test names; every method on `ChannelClient` has ≥ 2 tests.

## Done when

- All `[ ]` boxes checked
- `pnpm --filter @tainnel/sdk test --coverage` ≥ 80% lines
- Quickstart runs against `@tainnel/test-utils` mock hub
- Branch merged with `feat(sdk): implement ChannelClient open/pay/close`
