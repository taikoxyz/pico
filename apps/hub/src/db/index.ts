import BetterSqlite3, { type Database as BetterSqlite3Database } from 'better-sqlite3';
import type { HubConfig } from '../config.js';
import { applyMigrations } from './migrations.js';
import { ChannelRepo, DisputeRepo, HtlcRepo, NonceRepo, PaymentRepo, StateRepo } from './repos.js';

export interface Database {
  ready(): Promise<void>;
  close(): Promise<void>;
  raw(): BetterSqlite3Database;
}

export class SqliteDatabase implements Database {
  private db: BetterSqlite3Database | undefined;

  constructor(private readonly url: string) {}

  async ready(): Promise<void> {
    if (this.db) return;
    this.db = new BetterSqlite3(this.url);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    applyMigrations(this.db);
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = undefined;
  }

  raw(): BetterSqlite3Database {
    if (!this.db) throw new Error('database not ready');
    return this.db;
  }
}

export class PostgresDatabase implements Database {
  constructor(private readonly url: string) {}

  async ready(): Promise<void> {
    throw new Error('postgres not implemented for v1; use sqlite');
  }

  async close(): Promise<void> {}

  raw(): BetterSqlite3Database {
    throw new Error('postgres not implemented for v1');
  }
}

export function openDatabase(config: HubConfig): Database {
  if (config.dbDriver === 'postgres') return new PostgresDatabase(config.dbUrl);
  return new SqliteDatabase(config.dbUrl);
}

export interface Repositories {
  readonly channels: ChannelRepo;
  readonly states: StateRepo;
  readonly htlcs: HtlcRepo;
  readonly payments: PaymentRepo;
  readonly nonces: NonceRepo;
  readonly disputes: DisputeRepo;
}

export function buildRepos(db: Database): Repositories {
  const raw = db.raw();
  return {
    channels: new ChannelRepo(raw),
    states: new StateRepo(raw),
    htlcs: new HtlcRepo(raw),
    payments: new PaymentRepo(raw),
    nonces: new NonceRepo(raw),
    disputes: new DisputeRepo(raw),
  };
}

export * from './repos.js';
export * from './migrations.js';
export * from './serialize.js';
