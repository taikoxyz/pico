import { type ChildProcess, execSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

function litestreamOnPath(): boolean {
  try {
    execSync('litestream version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Loaded via dynamic import so the test skips cleanly when better-sqlite3
// is not hoisted into e2e's node_modules. Typed loosely to avoid pulling
// @types/better-sqlite3 as a hard dep.
type SqliteCtor = new (
  path: string,
  opts?: { readonly?: boolean },
) => {
  pragma(s: string): unknown;
  exec(s: string): void;
  prepare(s: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown;
  };
  close(): void;
};

async function loadBetterSqlite(): Promise<SqliteCtor | null> {
  try {
    // @ts-expect-error - better-sqlite3 is an optional runtime dep; module spec
    // is dynamic so the test skips cleanly when the package is not installed.
    const m = (await import('better-sqlite3')) as { default?: SqliteCtor } | SqliteCtor;
    return (m as { default?: SqliteCtor }).default ?? (m as SqliteCtor);
  } catch {
    return null;
  }
}

async function waitFor(check: () => boolean, timeoutMs: number, intervalMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor: timed out after ${timeoutMs}ms`);
}

const enabled = litestreamOnPath();

describe.skipIf(!enabled)('backup-restore', () => {
  let workdir: string;
  let dbPath: string;
  let replicaDir: string;
  let configPath: string;
  let replicateProc: ChildProcess | null = null;

  beforeAll(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'tainnel-backup-restore-'));
    dbPath = join(workdir, 'hub.sqlite');
    replicaDir = join(workdir, 'replica');
    configPath = join(workdir, 'litestream.yml');

    const Database = await loadBetterSqlite();
    if (!Database) throw new Error('better-sqlite3 not available');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE channels (id TEXT PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    db.prepare('INSERT INTO channels (id, status) VALUES (?, ?)').run('ch-1', 'open');
    db.prepare('INSERT INTO channels (id, status) VALUES (?, ?)').run('ch-2', 'closed');
    db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('seq', '42');
    db.close();

    writeFileSync(
      configPath,
      `dbs:\n  - path: ${dbPath}\n    replicas:\n      - type: file\n        path: ${replicaDir}\n        sync-interval: 250ms\n`,
    );

    replicateProc = spawn('litestream', ['replicate', '-config', configPath], {
      stdio: 'ignore',
    });

    await waitFor(() => existsSync(replicaDir) && readdirSync(replicaDir).length > 0, 30_000);
  });

  afterAll(async () => {
    if (replicateProc && replicateProc.exitCode === null) {
      replicateProc.kill('SIGTERM');
      await waitFor(() => replicateProc?.exitCode !== null, 10_000).catch(() => {
        replicateProc?.kill('SIGKILL');
      });
    }
    if (workdir) rmSync(workdir, { recursive: true, force: true });
  });

  it('restores synthetic hub db with row parity', async () => {
    if (replicateProc && replicateProc.exitCode === null) {
      replicateProc.kill('SIGTERM');
      await waitFor(() => replicateProc?.exitCode !== null, 10_000).catch(() => {
        replicateProc?.kill('SIGKILL');
      });
    }

    const restored = join(workdir, 'restored.sqlite');
    execSync(`litestream restore -o "${restored}" -config "${configPath}" "${dbPath}"`, {
      stdio: 'pipe',
    });

    const Database = await loadBetterSqlite();
    if (!Database) throw new Error('better-sqlite3 not available');
    const db = new Database(restored, { readonly: true });
    const channels = db.prepare('SELECT id, status FROM channels ORDER BY id').all() as Array<{
      id: string;
      status: string;
    }>;
    const kv = db.prepare('SELECT value FROM kv WHERE key = ?').get('seq') as
      | { value: string }
      | undefined;
    db.close();

    expect(channels).toEqual([
      { id: 'ch-1', status: 'open' },
      { id: 'ch-2', status: 'closed' },
    ]);
    expect(kv?.value).toBe('42');
  });
});
