import type { HubConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { runMigrations } from './migrations.js';
import { openPostgresDriver } from './postgres.js';
import { openSqliteDriver } from './sqlite.js';
import type { DbDriver } from './types.js';

export type { DbDriver, Row } from './types.js';
export { runMigrations } from './migrations.js';

export interface OpenDatabaseOptions {
  readonly logger?: Logger;
  readonly migrationsDir?: string;
}

export interface Database {
  readonly driver: DbDriver;
  ready(): Promise<void>;
  close(): Promise<void>;
}

export function openDatabase(config: HubConfig, opts: OpenDatabaseOptions = {}): Database {
  const driver: DbDriver =
    config.dbDriver === 'postgres'
      ? openPostgresDriver({ url: config.dbUrl })
      : openSqliteDriver({ url: config.dbUrl });

  return {
    driver,
    async ready(): Promise<void> {
      await driver.ping();
      await runMigrations(driver, {
        ...(opts.migrationsDir !== undefined ? { dir: opts.migrationsDir } : {}),
        ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
      });
    },
    async close(): Promise<void> {
      await driver.close();
    },
  };
}
