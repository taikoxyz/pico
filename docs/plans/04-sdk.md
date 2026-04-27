# P4 — SDK

**Status:** 🔵 not started (interfaces only — `client.ts`, `transport.ts`, `wallet.ts`,
`storage.ts`, `payment.ts` are all method stubs that throw `not implemented`)
**Blocks:** P5 (hub WebSocket protocol depends on SDK message shapes), P7 (wallet UI)
**Effort:** ~1 week
**Depends on:** P3 (state machine real, esp. `signing.ts`)

## Decisions

### D4.1 Default storage adapter per environment
- **Default:** browser → IndexedDB; Node → file
- Decision: ☐ accept default ☐ also ship in-memory only for examples

### D4.2 Reconnect/backoff policy for `WebSocketTransport`
- **Default:** exponential backoff 200ms → 30s, infinite retry, jittered
- Decision: ☐ accept default ☐ cap retries

### D4.3 Persistence safety
- **Default:** every state update is persisted **before** sending the signature
  to the hub. If we sign then crash, the next process startup must find the new
  state on disk and resume.
- **Why it matters:** if the hub gets a signature but our local store doesn't have
  the corresponding state, the hub can later post that state on-chain and we can't
  challenge.
- Decision: ☐ persist-before-send (recommended) ☐ async write-after-send

## Implementation tasks

### Transport
- [ ] `[agent]` `WebSocketTransport.connect/close/send` — real implementation using
      browser-and-Node-compatible `ws` (use `WebSocket` global if available, else
      dynamically import `ws`).
- [ ] `[agent]` Backoff per D4.2.
- [ ] `[agent]` Message framing: every message is JSON with `{id, kind, payload}`.
      `id` is a UUID. The transport keeps a `Map<id, deferred>` for request/response
      pairs.
- [ ] `[agent]` Heartbeat ping every 30s; reconnect if 2 missed.
- [ ] `[agent]` `NostrRelayTransport` — leave as stub (Phase-2). Don't delete; just
      make sure the interface compiles.

### Storage
- [ ] `[agent]` `MemoryStorage` already exists; add `delete`, `clear`.
- [ ] `[agent]` `IndexedDBStorage` (browser): use a tiny wrapper, not Dexie or idb,
      to keep the bundle small.
- [ ] `[agent]` `FileStorage` (Node): atomic-rename pattern (`write tmp → rename`),
      JSON encoding. Per-channel file under `${root}/channels/${id}.json`.

### Wallet adapter
- [ ] `[agent]` `ViemWalletAdapter` wrapping a viem `WalletClient` from
      `createWalletClient(...)`. Uses `signTypedData` directly.
- [ ] `[agent]` `BrowserWalletAdapter` wrapping `window.ethereum` (EIP-1193) for
      browsers that don't ship a connected wagmi client. The wallet UI will use
      wagmi's hook output instead, but the SDK should be usable from a plain page.
- [ ] `[agent]` Document in README that the wallet adapter must be the **same
      address** as one of the channel's parties; otherwise sigs will fail.

### `ChannelClient.open(args)`
- [ ] `[agent]` Build the on-chain `openChannel` tx using viem; sign with the
      wallet adapter; submit; wait for `ChannelOpened` event.
- [ ] `[agent]` Persist the new `Channel` (status `pending` → `open` after event).
- [ ] `[agent]` Establish a WebSocket session with the hub; send a `subscribe`
      message; await ack.

### `ChannelClient.pay(request)`
- [ ] `[agent]` Generate preimage (32 random bytes), hash it, build an `Htlc`.
- [ ] `[agent]` Apply locally via `state-machine.addHtlc`; sign new state.
- [ ] `[agent]` **Persist before send** (D4.3).
- [ ] `[agent]` Send `pay` message to hub with state + sig + paymentHash + amount +
      recipient.
- [ ] `[agent]` Await `payment.settle` from hub with the preimage; verify it matches
      `paymentHash`; apply `settleHtlc` locally; sign settled state; persist.
- [ ] `[agent]` Timeout handling: if hub doesn't settle within
      `htlc.expiry - safetyMargin`, fail locally and broadcast a `failHtlc` update.

### `ChannelClient.close(id, opts)`
- [ ] `[agent]` Cooperative path: send `close.request` to hub with our latest
      signed state; await hub's counter-signed close-state; submit
      `closeCooperative` tx.
- [ ] `[agent]` If hub doesn't respond in 60s, fall back to `closeUnilateral` with
      the latest signed state we have.
- [ ] `[agent]` Listen for `ChannelFinalized` event before returning.

### `ChannelClient.list()`
- [ ] `[agent]` Already half-implemented; expose `getBalance(id)` returning
      `(balanceUs, balanceCounterparty, pendingHtlcsTotal)`.

### Tests
- [ ] `[agent]` Unit tests with a mock `Transport` (in-memory pipe), mock wallet
      adapter, mock storage. Cover open/pay/close happy paths.
- [ ] `[agent]` Persistence-survives-crash test: simulate a crash between sign-and-
      send; reload; assert state machine is sane and we can recover.

## Quickstart example

- [ ] `[agent]` `packages/sdk/README.md` quickstart should be runnable against a
      mock hub from `@tainnel/test-utils`. Include:
      ```ts
      import { ChannelClient, MemoryStorage, ... } from '@tainnel/sdk';
      // ... 20 lines that open, pay, close ...
      ```
- [ ] `[agent]` Add `examples/sdk-mock-flow.ts` exercising the quickstart end-to-end.

## `[review]` gates

- You read the persist-before-send code path in `pay()`. This is the single most
  safety-critical line in the SDK.
- You skim the test names; every method on `ChannelClient` has ≥ 2 tests.

## Done when

- All `[ ]` boxes checked
- `pnpm --filter @tainnel/sdk test --coverage` ≥ 80% lines
- Quickstart runs against `@tainnel/test-utils` mock hub
- Branch merged with `feat(sdk): implement ChannelClient open/pay/close`
