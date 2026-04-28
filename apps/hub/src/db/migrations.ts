import type { Database as BetterSqlite3Database } from 'better-sqlite3';

export interface Migration {
  readonly version: number;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS channels (
        id          TEXT PRIMARY KEY,
        chain_id    INTEGER NOT NULL,
        contract    TEXT NOT NULL,
        user_a      TEXT NOT NULL,
        user_b      TEXT NOT NULL,
        token       TEXT NOT NULL,
        status      TEXT NOT NULL,
        opened_at   TEXT NOT NULL,
        dispute_window_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS signed_states (
        channel_id  TEXT NOT NULL,
        version     TEXT NOT NULL,
        state_json  TEXT NOT NULL,
        sig_a       TEXT NOT NULL,
        sig_b       TEXT NOT NULL,
        recorded_at INTEGER NOT NULL,
        PRIMARY KEY (channel_id, version)
      );

      CREATE INDEX IF NOT EXISTS idx_signed_states_channel
        ON signed_states (channel_id);

      CREATE TABLE IF NOT EXISTS htlcs (
        id              TEXT PRIMARY KEY,
        channel_id      TEXT NOT NULL,
        payment_hash    TEXT NOT NULL,
        amount          TEXT NOT NULL,
        expiry_ms       TEXT NOT NULL,
        direction       TEXT NOT NULL,
        status          TEXT NOT NULL,
        settled_preimage TEXT,
        created_at      INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_htlcs_channel_status
        ON htlcs (channel_id, status);

      CREATE INDEX IF NOT EXISTS idx_htlcs_payment_hash
        ON htlcs (payment_hash);

      CREATE TABLE IF NOT EXISTS payments (
        id             TEXT PRIMARY KEY,
        source_channel TEXT NOT NULL,
        dest_channel   TEXT,
        amount         TEXT NOT NULL,
        payment_hash   TEXT NOT NULL,
        status         TEXT NOT NULL,
        started_at     INTEGER NOT NULL,
        completed_at   INTEGER,
        fee_paid       TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_payments_payment_hash
        ON payments (payment_hash);

      CREATE TABLE IF NOT EXISTS seen_nonces (
        nonce   TEXT PRIMARY KEY,
        addr    TEXT NOT NULL,
        seen_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_seen_nonces_seen_at
        ON seen_nonces (seen_at);

      CREATE TABLE IF NOT EXISTS disputes (
        channel_id      TEXT PRIMARY KEY,
        attacker_version TEXT NOT NULL,
        our_version     TEXT NOT NULL,
        observed_at     INTEGER NOT NULL,
        responded_at    INTEGER,
        tx_hash         TEXT
      );
    `,
  },
];

export function applyMigrations(db: BetterSqlite3Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = new Set(
    db
      .prepare('SELECT version FROM _schema_migrations')
      .all()
      .map((row) => (row as { version: number }).version),
  );

  const insertVersion = db.prepare(
    'INSERT INTO _schema_migrations (version, applied_at) VALUES (?, ?)',
  );

  const tx = db.transaction((pending: readonly Migration[]) => {
    for (const m of pending) {
      db.exec(m.sql);
      insertVersion.run(m.version, Date.now());
    }
  });

  const pending = MIGRATIONS.filter((m) => !applied.has(m.version));
  if (pending.length > 0) tx(pending);
}
