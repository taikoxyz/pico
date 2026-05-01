# Backup and restore (DRAFT — verify before P10)

## v1 backup model

- Hub DB: SQLite at `./data/hub.sqlite`, replicated by litestream to
  S3-compatible object storage (Cloudflare R2 in `docs/plans/09-ops.md`).
- Watchtower DB: SQLite at `./data/watchtower.sqlite`. **Not** litestream-backed
  in v1 because the watchtower can rebuild in-flight state from chain logs and
  channel-party hub on restart; review this assumption before P10.
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

## Restore: watchtower from scratch

```bash
# 1) Provision new host with same config + WATCHTOWER_PRIVATE_KEY.
# 2) Start the watchtower; it will catch up from the chain.
# 3) Re-deliver the freshest signed state for each open channel via the hub:
#    POST /v1/states/sync (or whatever the operational tool is once P9 lands).
```

## Drill checklist (run quarterly, mandatory pre-P10)

- [ ] Backup verified by restoring to a clean volume.
- [ ] Restored DB hashes match the source post-restore.
- [ ] Hub serves traffic without error after restore.
- [ ] All open channels visible via `GET /v1/channels`.
- [ ] No payment_routes orphans (each `inflight` row in `payment_routes`
      has matching `htlcs` and `payments` rows).

## Open items

- Confirm litestream credentials and bucket lifecycle policy (retention,
  encryption-at-rest, region) before P10.
- Decide whether to add a watchtower SQLite backup once `closing_channels`
  becomes the durable work queue (see WTW-002).
