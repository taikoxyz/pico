import type { HubConfig } from '../config.js';

export interface Database {
  ready(): Promise<void>;
  close(): Promise<void>;
}

class SqliteDatabase implements Database {
  constructor(private readonly url: string) {}
  async ready(): Promise<void> {
    return undefined;
  }
  async close(): Promise<void> {
    return undefined;
  }
}

class PostgresDatabase implements Database {
  constructor(private readonly url: string) {}
  async ready(): Promise<void> {
    return undefined;
  }
  async close(): Promise<void> {
    return undefined;
  }
}

export function openDatabase(config: HubConfig): Database {
  if (config.dbDriver === 'postgres') {
    return new PostgresDatabase(config.dbUrl);
  }
  return new SqliteDatabase(config.dbUrl);
}
