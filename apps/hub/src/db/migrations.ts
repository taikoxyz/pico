import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '../logger.js';
import type { DbDriver } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

const ENSURE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS _migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
)`;

export interface RunMigrationsOptions {
  readonly dir?: string;
  readonly logger?: Logger;
}

export async function runMigrations(db: DbDriver, opts: RunMigrationsOptions = {}): Promise<void> {
  const dir = opts.dir ?? DEFAULT_MIGRATIONS_DIR;
  await db.executeScript(ENSURE_TABLE_SQL);
  const applied = new Set(
    (await db.query<{ name: string }>('SELECT name FROM _migrations')).map((r) => r.name),
  );
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    await db.transaction(async (tx) => {
      await tx.executeScript(sql);
      await tx.exec('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)', [
        file,
        String(Date.now()),
      ]);
    });
    opts.logger?.info({ migration: file }, 'migration applied');
  }
}
