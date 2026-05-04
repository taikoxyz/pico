# @pico/watchtower

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
v1**. Setting `MODE=service` is rejected at startup with a clear error. See
`docs/plans/06-watchtower.md` for the roadmap.
