# P4 — SDK

**Status:** 🟢 done — `pnpm --filter @tainnel/sdk test` passes after workspace
packages are built.
`ChannelClient`, WebSocket transport, storage adapters, signer interface, invoice
flow, keysend flow, chain adapter, and test utilities are implemented.
**Blocks:** —
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
    signChannelState(state, chainId, verifyingContract): Promise<Hex>;
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

## Implementation record

The SDK now includes:

- `WebSocketTransport` with JSON message framing, request/response correlation,
  heartbeat, reconnect, and reconnect hooks.
- `MemoryStorage`, `FileStorage`, and `IndexedDBStorage`.
- `Signer` interface plus a test-only in-memory signer; the CLI owns the v1 key-file
  backend.
- `ChannelClient.open`, `createInvoice`, `pay`, `close`, `list`, `getBalance`, and
  listen-mode event handling.
- Invoice-mode and keysend-mode payment support.
- Persist-before-send behavior and crash-recovery tests.
- `packages/sdk/README.md` and `examples/sdk-mock-flow.ts` for the mock-hub quickstart.
- 104 SDK tests covering storage, transport, signer, invoice, keysend, chain adapter,
  close flow, mock-hub integration, and crash recovery.

There are no remaining P4-specific blockers for the controlled mainnet real-money E2E
test. Remaining readiness work is in the real hub/watchtower/e2e/ops layers.

## `[review]` gates

- You read the persist-before-send code path in `pay()`. This is the single most
  safety-critical line in the SDK.
- You skim the test names; every method on `ChannelClient` has ≥ 2 tests.

## Done when

- `pnpm --filter @tainnel/sdk test` passes.
- Quickstart exists and runs against `@tainnel/test-utils` mock hub.
- The roadmap marks P4 🟢 and does not list P4 as a blocker for mainnet E2E testing.
