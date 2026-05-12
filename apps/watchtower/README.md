# @inferenceroom/pico-watchtower

Standalone monitoring service that subscribes to `PaymentChannel` events on-chain,
detects when a counterparty publishes an old (fraudulent) state, and submits a
penalty transaction before the dispute window closes.

## v1 status (self-hosted only)

- Single-user. The watchtower watches the channels its operator participates in.
- Storage is **plaintext SQLite** (signed states, signatures, in-flight tx
  metadata). Treat the SQLite file as fund-sensitive. Recommended controls:
  - filesystem encryption (LUKS, FileVault, or equivalent),
  - `0700`/`0600` directory and file modes,
  - host-level access control.
- Encrypted at-rest blobs (`EncryptedBackup`/`BackupStore`) are sketched in
  `src/storage.ts` but **not wired into the runtime path**. They will land
  alongside the service-mode work.

## Service mode (deferred)

Multi-tenant, encrypted-blob ingestion service mode is **not implemented in
v1**. Setting `MODE=service` is rejected at startup with a clear error.

## v2 HTLC settlement (storage & operations)

v2 adds on-chain HTLC settlement, which means the watchtower now persists the
**full HTLC set** of every signed state — not just the Merkle root — so it can
build inclusion proofs at resolution time. Per-channel storage grows roughly
5× compared to v1:

- Each signed state row carries the serialized `htlcs[]` array
  (≤ `MAX_HTLCS_PER_CHANNEL` = 5 entries × ~120 bytes each).
- A new `preimages` table holds learned preimages keyed by `paymentHash`.
- Empirical estimate: **500 KB – 1 MB per active channel** under heavy use.

Recommended retention policy:

- Prune rows older than the channel's dispute window once `ChannelFinalized`
  fires for that channelId.
- Vacuum the SQLite file periodically (`PRAGMA optimize`); WAL mode is already
  enabled for on-disk DBs.

### Preimage forwarder endpoint

When `preimageAuthToken` is configured at startup, the watchtower exposes:

```
POST /v1/preimage
Authorization: Bearer <token>
Content-Type: application/json

{ "paymentHash": "0x<32 hex>", "preimage": "0x<hex>" }
```

Hubs forward seen preimages so the watchtower can post `claimHtlc` on behalf
of an offline payee. The handler stores idempotently keyed on `paymentHash`;
an unknown channel is OK — the resolver will pick the preimage up if/when
that channel ever reaches `Status.ResolvingHtlcs`.
