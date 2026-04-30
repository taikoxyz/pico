import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Sqlite from 'better-sqlite3';
import type { DbDriver, Row } from './types.js';

export interface SqliteDriverOptions {
  readonly url: string;
}

export function openSqliteDriver(opts: SqliteDriverOptions): DbDriver {
  const path = opts.url.replace(/^sqlite:\/\//, '');
  if (path !== ':memory:') {
    const dir = dirname(path);
    if (dir && dir !== '.') mkdirSync(dir, { recursive: true });
  }
  const db = new Sqlite(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return wrapSqlite(db);
}

function wrapSqlite(db: Sqlite.Database): DbDriver {
  const driver: DbDriver = {
    async query<R = Row>(sql: string, params: readonly unknown[] = []): Promise<readonly R[]> {
      const stmt = db.prepare(sql);
      const rows = stmt.all(...(params as unknown[])) as R[];
      return rows;
    },
    async exec(sql: string, params: readonly unknown[] = []): Promise<{ changes: number }> {
      const stmt = db.prepare(sql);
      const info = stmt.run(...(params as unknown[]));
      return { changes: info.changes };
    },
    async executeScript(sql: string): Promise<void> {
      db.exec(sql);
    },
    async transaction<T>(fn: (tx: DbDriver) => Promise<T>): Promise<T> {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(driver);
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    async ping(): Promise<void> {
      db.prepare('SELECT 1').get();
    },
    async close(): Promise<void> {
      db.close();
    },
  };
  return driver;
}
