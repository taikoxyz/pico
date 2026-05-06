-- Lifetime hub statistics (payment counts, USDC processed, fees collected).
-- Values are stored as decimal strings so bigint deltas can survive round-tripping
-- without JS Number precision loss. Updates use a single atomic upsert that
-- arithmetically adds excluded.value to the existing row, so concurrent settle
-- handlers do not lose increments. Survives restarts since rows are durable.

CREATE TABLE hub_stats (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '0'
);
