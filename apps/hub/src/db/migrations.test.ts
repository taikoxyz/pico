import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from './migrations.js';
import { openSqliteDriver } from './sqlite.js';
import type { DbDriver } from './types.js';

describe('runMigrations', () => {
  let tmp: string;
  let driver: DbDriver;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'hub-mig-'));
    driver = openSqliteDriver({ url: join(tmp, 'test.sqlite') });
  });

  afterEach(async () => {
    await driver.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('creates the expected schema on a fresh DB', async () => {
    await runMigrations(driver);
    const tables = await driver.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const names = tables.map((t) => t.name);
    for (const expected of [
      '_migrations',
      'channels',
      'disputes',
      'htlcs',
      'kv',
      'payments',
      'seen_nonces',
      'signed_states',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('is idempotent — running twice does not throw', async () => {
    await runMigrations(driver);
    await runMigrations(driver);
    const applied = await driver.query<{ name: string }>('SELECT name FROM _migrations');
    expect(applied.length).toBeGreaterThan(0);
  });
});
