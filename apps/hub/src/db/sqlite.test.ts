import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteDriver } from './sqlite.js';
import type { DbDriver } from './types.js';

describe('openSqliteDriver', () => {
  let tmp: string;
  let driver: DbDriver;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'hub-sqlite-'));
    driver = openSqliteDriver({ url: join(tmp, 'test.sqlite') });
  });

  afterEach(async () => {
    await driver.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('round-trips rows through query/exec', async () => {
    await driver.executeScript(
      'CREATE TABLE t (id TEXT PRIMARY KEY, label TEXT NOT NULL, count TEXT NOT NULL)',
    );
    const r = await driver.exec('INSERT INTO t (id, label, count) VALUES (?, ?, ?)', [
      '1',
      'alpha',
      '42',
    ]);
    expect(r.changes).toBe(1);
    const rows = await driver.query<{ id: string; label: string; count: string }>(
      'SELECT id, label, count FROM t WHERE id = ?',
      ['1'],
    );
    expect(rows).toEqual([{ id: '1', label: 'alpha', count: '42' }]);
  });

  it('commits transactions and returns the result', async () => {
    await driver.executeScript('CREATE TABLE t (id TEXT PRIMARY KEY)');
    const result = await driver.transaction(async (tx) => {
      await tx.exec('INSERT INTO t (id) VALUES (?)', ['a']);
      await tx.exec('INSERT INTO t (id) VALUES (?)', ['b']);
      return 'done';
    });
    expect(result).toBe('done');
    const count = await driver.query<{ n: number }>('SELECT COUNT(*) as n FROM t');
    expect(count[0]?.n).toBe(2);
  });

  it('rolls back transactions when fn throws', async () => {
    await driver.executeScript('CREATE TABLE t (id TEXT PRIMARY KEY)');
    await expect(
      driver.transaction(async (tx) => {
        await tx.exec('INSERT INTO t (id) VALUES (?)', ['a']);
        throw new Error('boom');
      }),
    ).rejects.toThrow(/boom/);
    const count = await driver.query<{ n: number }>('SELECT COUNT(*) as n FROM t');
    expect(count[0]?.n).toBe(0);
  });

  it('ping resolves on a healthy connection', async () => {
    await expect(driver.ping()).resolves.toBeUndefined();
  });

  it('creates the parent directory when it does not exist', async () => {
    const nested = mkdtempSync(join(tmpdir(), 'hub-sqlite-mkdir-'));
    const target = join(nested, 'a', 'b', 'c', 'fresh.sqlite');
    const d = openSqliteDriver({ url: target });
    try {
      await expect(d.ping()).resolves.toBeUndefined();
    } finally {
      await d.close();
      rmSync(nested, { recursive: true, force: true });
    }
  });
});
