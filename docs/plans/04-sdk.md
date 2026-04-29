# P4 — SDK

**Status:** 🔵 not started (interfaces only — `client.ts`, `transport.ts`, `wallet.ts`,
`storage.ts`, `payment.ts` are all method stubs that throw `not implemented`)
**Blocks:** P5 (hub WebSocket protocol depends on SDK message shapes), P7 (CLI agent
runtime)
**Effort:** ~1 week
**Depends on:** P3 (state machine real, esp. `signing.ts`)

## v1 SDK consumers

The SDK is consumed in v1 by:

- **`apps/cli`** — the canonical agent runtime (P7). One-shot commands like
  `tainnel pay`, plus the `tainnel listen` long-running daemon mode for receivers.
  The CLI is the primary failure surface for the dogfood launch.
- **`apps/hub`** — uses the same state-machine and protocol types but talks to the
  network from the other side. It does not import `ChannelClient`, only the shared
  primitives.
- **`@tainnel/test-utils`** — drives mock hubs and harnessed scenarios for unit /
  integration / e2e tests.

The React wallet UI is **deferred to Phase 2** and the previous `apps/wallet-ui`
skeleton has been removed from the tree; the SDK's quickstart docs and examples must
target a CLI / agent-script audience, not a browser. The Phase 2 wallet UI starting
outline lives at the bottom of `docs/plans/07-agent-runtime.md`.

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

### D4.4 `Signer` interface (new in v1 re-scope)
- **Default:** define a small `Signer` interface inside the SDK that abstracts every
  EIP-712 signature the channel needs. v1 ships exactly one backend: a
  passphrase-encrypted hot key file (the implementation lives in P7's CLI, the
  interface lives here in P4).
- **Methods:**
  ```ts
  interface Signer {
    address(): Promise<Address>;
    signChannelState(state, chainId, verifyingContract, htlcsRoot): Promise<Hex>;
    signUpdate(u, chainId, verifyingContract): Promise<Hex>;
    signCooperativeClose(cc, chainId, verifyingContract): Promise<Hex>;
    signHtlc(htlc, chainId, verifyingContract): Promise<Hex>;
    signInvoice(invoice, chainId): Promise<Hex>;
  }
  ```
  Hashing for these typed-data structs lives in `@tainnel/state-machine` (P3); the
  Signer is purely a key-custody adapter.
- **Documented escape hatch:** future backends — AWS Nitro Enclave, Turnkey, AWS/GCP
  KMS, EIP-7702 delegation — implement the same interface. The SDK and CLI never call
  a private key directly; everything goes through `Signer`.
- Decision: ☐ accept default Signer interface and v1 backend ☐ alternative shape

### D4.5 Payment model (preimage origin)

The HTLC preimage `P` (32 random bytes; `paymentHash = sha256(P)`) is the cryptographic
hinge of every payment: only the holder of `P` can settle the HTLC, and revealing `P`
is the act that propagates the payment back through the route. Two patterns exist in
the wild; v1 ships **both**, with invoice-mode as the default.

- **Pattern A (default) — invoice / receiver-generates `P`.**
  Bob's agent generates `P` from a CSPRNG, computes `H`, persists `{P, H, amount,
  expiry, ...}` in the SDK invoice store, hands Alice an invoice envelope (see below).
  Alice runs `tainnel pay --invoice <invoice>`. The HTLC locks against `H`. Bob's
  `tainnel listen` recognizes `H` from the invoice store, looks up `P`, settles. The
  preimage propagates upstream and ends up in Alice's `PaymentResult` as the
  cryptographic receipt of payment. This maps cleanly onto the canonical paid-API
  flow: `GET /quote → 402 + invoice → tainnel pay → P → GET /resource Authorization:
  tainnel-receipt <P>`.
- **Pattern B (opt-in `--keysend`) — sender-generates `P`.**
  Alice generates `P` herself and includes a side payload encrypted to Bob's public
  key alongside the HTLC offer. The hub forwards the HTLC and the (still-encrypted)
  payload; Bob decrypts, learns `P`, settles. Useful for tipping or pushing payments
  to agents that don't expose an invoice endpoint. No semantic binding between `P`
  and a specific service — `P` is just a number to Bob unless Alice puts service
  context in the encrypted payload.

The receiver's `tainnel listen` must support both. On HTLC arrival, look up `H` in
the invoice store first; if not found and the offer carries a keysend payload,
decrypt it and use that `P`; otherwise reject with a typed error.

#### Invoice envelope (v1 format)

Lives in the SDK as a JSON object signed by the recipient. Not stored on chain;
purely a coordination artifact between Alice and Bob.

```ts
interface Invoice {
  paymentHash: Hex;        // sha256(P), 0x-prefixed bytes32
  amount: bigint;          // base units of the channel token (USDC = 6 decimals)
  recipient: Address;      // Bob's address — same as the channel party
  expiryMs: bigint;        // wall-clock expiry; SDK rejects invoices past this
  hubHint?: string;        // optional preferred hub URL (not binding)
  memo?: string;           // optional UTF-8, ≤ 256 bytes; included in HTLC for receipts
  nonce: Hex;              // 16 random bytes; lets recipient dedupe replays
  signature: Hex;          // EIP-712 sig by recipient over (chainId, paymentHash, amount, recipient, expiryMs, memo?, nonce)
}
```

The signature lets Alice (and the hub) verify the invoice came from the address
that's about to receive funds. The Invoice typed-data schema is added to
`@tainnel/protocol` alongside the existing channel schemas.

- Decision: ☐ Pattern A as default + Pattern B behind `--keysend` (recommended)
  ☐ Pattern A only ☐ Pattern B only

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

### Signer (v1 — keep flexible for Phase 2 backends)
- [ ] `[agent]` Define `Signer` interface (D4.4) in `packages/sdk/src/signer.ts`.
      All four `sign*` methods + `address()`. No `Signer` implementation lives in this
      package; the v1 default backend ships in `apps/cli` (P7).
- [ ] `[agent]` Provide an `InMemorySigner` (test-only) in
      `packages/sdk/src/signer.test-only.ts` that takes a raw private key and uses
      viem's `privateKeyToAccount` + `signTypedData` for hashes computed by
      `@tainnel/state-machine`. Re-exported from `@tainnel/test-utils`, never from the
      public SDK entry point.
- [ ] `[agent]` Document the **same-address** invariant in the README: the address
      from `Signer.address()` must match one of the channel's parties; otherwise
      EIP-712 sig verification fails.
- [ ] `[agent]` Phase-2 escape hatch note: backends targeting KMS, Turnkey, Nitro
      Enclave, or EIP-7702 delegation implement the same `Signer` interface. No SDK
      changes needed for those.

### `ChannelClient.open(args)`
- [ ] `[agent]` Build the on-chain `openChannel` tx using viem; sign with the
      wallet adapter; submit; wait for `ChannelOpened` event.
- [ ] `[agent]` Persist the new `Channel` (status `pending` → `open` after event).
- [ ] `[agent]` Establish a WebSocket session with the hub; send a `subscribe`
      message; await ack.

### `ChannelClient.createInvoice(args)` (new — Pattern A receiver side)
- [ ] `[agent]` Generate preimage `P` (32 bytes from `crypto.randomBytes` /
      `crypto.getRandomValues`), compute `paymentHash = sha256(P)`.
- [ ] `[agent]` Build `Invoice` envelope per D4.5; sign with `Signer.signInvoice`.
- [ ] `[agent]` Persist `{P, paymentHash, amount, expiryMs, recipient, memo, nonce}`
      in the SDK invoice store (`storage` bucket: `invoices/`). Listen-mode reads
      from this store on inbound HTLC arrival.
- [ ] `[agent]` Return the signed `Invoice` to the caller. The agent author serves
      it from their HTTP endpoint (or hands it to Alice over Nostr DM, whatever).

### `ChannelClient.pay(request)`
- [ ] `[agent]` Two call shapes:
      1. **Pattern A (default):** `pay({invoice})`. Validate signature, expiry, and
         recipient. Build an `Htlc` locked against `invoice.paymentHash` for
         `invoice.amount + hub-quoted fee`.
      2. **Pattern B (`--keysend`):** `pay({to, amount, keysend: true, payload?})`.
         Generate preimage `P` locally, hash it, build the HTLC, and attach a side
         payload `{P, payload?}` encrypted to `to`'s public key (NaCl/libsodium
         sealed box).
- [ ] `[agent]` Apply locally via `state-machine.addHtlc`; sign new state.
- [ ] `[agent]` **Persist before send** (D4.3).
- [ ] `[agent]` Send `pay` message to hub with state + sig + paymentHash + amount +
      recipient + optional `keysendPayload`.
- [ ] `[agent]` Await `payment.settle` from hub with the preimage; verify
      `sha256(preimage) == paymentHash`; apply `settleHtlc` locally; sign settled
      state; persist. Return `{preimage, settledAtMs, channelId}` — the preimage is
      the cryptographic receipt the agent author shows back to the recipient's
      service to authenticate (e.g., `Authorization: tainnel-receipt <preimage>`).
- [ ] `[agent]` Timeout handling: if hub doesn't settle within
      `htlc.expiry - safetyMargin`, fail locally and broadcast a `failHtlc` update.

### Listen-mode receive flow (consumed by `tainnel listen` from P7)
- [ ] `[agent]` On inbound HTLC offer, look up `paymentHash` in the invoice store
      first.
      - **Hit (Pattern A):** retrieve `P`; verify HTLC amount/expiry vs invoice;
        sign settle, persist, ack hub with the preimage. Mark invoice consumed
        (idempotent on duplicate arrival of same `paymentHash`).
      - **Miss + offer carries `keysendPayload`:** decrypt with the receiver's key;
        extract `P`; verify `sha256(P) == paymentHash`; sign settle and ack with
        `P`. Save `{P, paymentHash, amount, memo}` to a "received-keysend" log.
      - **Miss + no keysend payload:** reject with `UnknownPaymentHashError`; let
        the HTLC expire upstream so Alice's funds bounce back.

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
- [ ] `[agent]` **Invoice flow tests:** `createInvoice` → invoice signature verifies
      against recipient address; expired invoice rejected by `pay({invoice})`; mutated
      invoice (any field flipped) rejected; replay (same `paymentHash` arriving
      twice) is idempotent.
- [ ] `[agent]` **Keysend flow tests:** `pay({to, amount, keysend: true})` builds a
      sealed-box payload with the right recipient pubkey; listen-mode decrypts and
      settles.
- [ ] `[agent]` Persistence-survives-crash test: simulate a crash between sign-and-
      send; reload; assert state machine is sane and we can recover.

## Quickstart example

- [ ] `[agent]` `packages/sdk/README.md` quickstart should be runnable against a
      mock hub from `@tainnel/test-utils`. Audience is **agent authors writing TS
      from a Node script**, not a browser app. Include:
      ```ts
      import { ChannelClient, FileStorage, WebSocketTransport } from '@tainnel/sdk';
      import { InMemorySigner } from '@tainnel/test-utils';
      // ~20 lines that open, pay, close against a mock hub.
      ```
- [ ] `[agent]` Add `examples/sdk-mock-flow.ts` exercising the quickstart end-to-end.
- [ ] `[agent]` Cross-link from the README to `apps/cli` so agent authors who do not
      want to write TS know they can shell out to `tainnel pay --json` instead.

## Listen-mode contract (consumed by `tainnel listen`)

The `tainnel listen` daemon (P7) is a top-level SDK consumer. The SDK MUST:

- [ ] `[agent]` Allow a `ChannelClient` to be constructed without an open channel —
      it should still be able to subscribe and accept inbound HTLCs based on storage
      state.
- [ ] `[agent]` `WebSocketTransport` must support reconnect with **state replay**:
      when a session reconnects, the SDK pushes the latest signed state per channel
      so the hub can replay any in-flight HTLC. Idempotent on duplicates.
- [ ] `[agent]` Provide an event API (`client.on('htlc:incoming', ...)`,
      `client.on('htlc:settled', ...)`, `client.on('error', ...)`) so the listen
      command can structure its log output and exit codes around well-defined
      transitions.

## `[review]` gates

- You read the persist-before-send code path in `pay()`. This is the single most
  safety-critical line in the SDK.
- You skim the test names; every method on `ChannelClient` has ≥ 2 tests.

## Done when

- All `[ ]` boxes checked
- `pnpm --filter @tainnel/sdk test --coverage` ≥ 80% lines
- Quickstart runs against `@tainnel/test-utils` mock hub
- Branch merged with `feat(sdk): implement ChannelClient open/pay/close`
