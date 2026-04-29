import type { Database as BetterSqlite3Database } from 'better-sqlite3';

export interface Migration {
  readonly version: number;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS signed_states (
        channel_id TEXT NOT NULL,
        version TEXT NOT NULL,
        state_json TEXT NOT NULL,
        sig_a TEXT NOT NULL,
        sig_b TEXT NOT NULL,
        recorded_at INTEGER NOT NULL,
        PRIMARY KEY (channel_id, version)
      );

      CREATE INDEX IF NOT EXISTS idx_signed_states_channel
        ON signed_states (channel_id);

      CREATE TABLE IF NOT EXISTS watchtower_observations (
        channel_id TEXT PRIMARY KEY,
        posted_version TEXT NOT NULL,
        posted_at INTEGER NOT NULL,
        our_latest_version TEXT NOT NULL,
        action_taken TEXT NOT NULL,
        submit_by INTEGER NOT NULL,
        tx_hash TEXT,
        submitted_at INTEGER,
        included_at INTEGER,
        last_block INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_observations_pending
        ON watchtower_observations (submitted_at, submit_by);

      CREATE TABLE IF NOT EXISTS watchtower_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
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
