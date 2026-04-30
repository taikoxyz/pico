import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../migrations.js';
import { openSqliteDriver } from '../sqlite.js';
import type { DbDriver } from '../types.js';
import { type Repos, buildRepos } from './index.js';

export interface TestDb {
  readonly driver: DbDriver;
  readonly repos: Repos;
  readonly cleanup: () => Promise<void>;
}

export async function makeTestDb(): Promise<TestDb> {
  const tmp = mkdtempSync(join(tmpdir(), 'hub-repo-'));
  const driver = openSqliteDriver({ url: join(tmp, 'test.sqlite') });
  await runMigrations(driver);
  const repos = buildRepos(driver);
  return {
    driver,
    repos,
    async cleanup(): Promise<void> {
      await driver.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}
