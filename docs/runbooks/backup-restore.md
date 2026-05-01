# Backup and restore

## v1 backup model

- Hub DB: SQLite at `./data/hub.sqlite`, replicated by litestream to
  S3-compatible object storage (Cloudflare R2 in `docs/plans/09-ops.md`).
  Sidecar config: `infra/litestream/hub.yml`.
- Watchtower DB: SQLite at `./data/watchtower.sqlite`, replicated to its own
  bucket (separate region) via the sidecar in
  `infra/docker-compose.watchtower.yml`. The original v1 assumption that the
  watchtower could rebuild from chain logs alone is wrong: `in_flight_txs`
  holds penalty txs with bumped fees and reserved nonces (see
  `apps/watchtower/src/storage.ts:131-166`) that cannot be reconstructed from
  on-chain data. Sidecar config: `infra/litestream/watchtower.yml`.
- Encrypted hot key files: backed up out-of-band by the operator (not in the
  application backup path).

## Restore: hub from litestream

```bash
# 1) Provision new host with same config; do NOT start the hub yet.
# 2) Restore the database.
litestream restore -o ./data/hub.sqlite \
  s3://tainnel-hub-backups/hub.sqlite

# 3) Verify schema + row counts before starting:
sqlite3 ./data/hub.sqlite "SELECT name FROM sqlite_master WHERE type='table';"
sqlite3 ./data/hub.sqlite "SELECT count(*) FROM channels;"

# 4) Start the hub. Router rehydrates in-flight HTLC routes from
#    payment_routes + states tables on boot.
fly machine start -a tainnel-hub
```

## Restore: watchtower from litestream

```bash
# 1) Provision new host with same config + WATCHTOWER_PRIVATE_KEY.
# 2) Restore the database BEFORE starting the watchtower.
litestream restore -o ./data/watchtower.sqlite \
  s3://tainnel-watchtower-backups/watchtower.sqlite

# 3) Verify schema + row counts before starting (see drill below).
sqlite3 ./data/watchtower.sqlite "SELECT name FROM sqlite_master WHERE type='table';"
sqlite3 ./data/watchtower.sqlite "SELECT count(*) FROM in_flight_txs;"

# 4) Start the watchtower; it will resume in-flight penalty txs from
#    in_flight_txs and re-evaluate observations from watchtower_observations.
fly machine start -a tainnel-watchtower
```

## Restore drill (quarterly, mandatory pre-launch)

Use the scripted drill — it does the restore plus schema and row sanity
checks in one shot:

```bash
infra/scripts/restore-drill.sh --service hub        --target-volume /tmp/restore-hub
infra/scripts/restore-drill.sh --service watchtower --target-volume /tmp/restore-wt
```

A green `OK service=hub rows=channels:N states:N ... sha=<short>` line means
the bucket is reachable, the DB restored, sha is stable on read, and every
load-bearing table is queryable. Anything red is a real failure — file an
incident. The CI workflow at `.github/workflows/backup-drill.yml` runs this
monthly against the staging buckets and opens a GitHub issue on failure.

Manual checklist after restore:

- [ ] Restored DB hashes match the source post-restore (drill script asserts).
- [ ] Hub serves traffic without error after restore (start it on the
      restored volume and curl `/v1/health`).
- [ ] All open channels visible via `GET /v1/channels`.
- [ ] No payment_routes orphans (each `inflight` row has matching `htlcs` +
      `payments` rows).
- [ ] Watchtower has visible `channels_watched > 0` and resumes
      `in_flight_txs` rebroadcast within `inclusionTimeoutMs`.

## Operator setup (off-repo)

These cannot be enforced from the repo. Do them once during Fly provisioning
and verify via the drill above:

- Provision two R2 buckets: `LITESTREAM_BUCKET_HUB` (US East) and
  `LITESTREAM_BUCKET_WATCHTOWER` (EU West, distinct region from hub).
- Apply server-side encryption (AES-256) at the bucket level.
- 30-day lifecycle policy on each bucket; protect against accidental
  deletion (R2 versioning + write-protected IAM policy).
- IAM scoped to `PutObject`, `GetObject`, `ListBucket` only — separate
  access keys per service.
- Set repo secrets so `.github/workflows/backup-drill.yml` can run:
  `STAGING_LITESTREAM_ACCESS_KEY_ID`, `STAGING_LITESTREAM_SECRET_ACCESS_KEY`,
  `STAGING_LITESTREAM_ENDPOINT`, `STAGING_LITESTREAM_REGION`,
  `STAGING_LITESTREAM_BUCKET_HUB`, `STAGING_LITESTREAM_BUCKET_WATCHTOWER`.
- Wire `infra/docker-compose.watchtower.yml` into the watchtower-host deploy.
