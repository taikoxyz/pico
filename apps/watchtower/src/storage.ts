import type { ChannelId, Hex, SignedState } from '@tainnel/protocol';
import BetterSqlite3, { type Database as BetterSqlite3Database } from 'better-sqlite3';
import { applyMigrations } from './migrations.js';

export interface EncryptedBackup {
  readonly channelId: ChannelId;
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly version: bigint;
}

export interface BackupStore {
  put(blob: EncryptedBackup): Promise<void>;
  latest(channelId: ChannelId): Promise<EncryptedBackup | undefined>;
}

export interface PlainStateStore {
  put(state: SignedState): Promise<void>;
  latest(channelId: ChannelId): Promise<SignedState | undefined>;
  list(): Promise<readonly SignedState[]>;
}

export type ObservationAction = 'penalize' | 'noop_stale' | 'noop_unknown';

export interface Observation {
  readonly channelId: ChannelId;
  readonly postedVersion: bigint;
  readonly postedAt: number;
  readonly ourLatestVersion: bigint;
  readonly actionTaken: ObservationAction;
  readonly submitBy: number;
  readonly txHash?: Hex;
  readonly submittedAt?: number;
  readonly includedAt?: number;
  readonly lastBlock?: number;
}

export class MemoryBackupStore implements BackupStore {
  private readonly map = new Map<ChannelId, EncryptedBackup>();

  async put(blob: EncryptedBackup): Promise<void> {
    const existing = this.map.get(blob.channelId);
    if (!existing || blob.version > existing.version) {
      this.map.set(blob.channelId, blob);
    }
  }

  async latest(channelId: ChannelId): Promise<EncryptedBackup | undefined> {
    return this.map.get(channelId);
  }
}

interface SignedStateRow {
  channel_id: string;
  version: string;
  state_json: string;
  sig_a: string;
  sig_b: string;
  recorded_at: number;
}

interface ObservationRow {
  channel_id: string;
  posted_version: string;
  posted_at: number;
  our_latest_version: string;
  action_taken: string;
  submit_by: number;
  tx_hash: string | null;
  submitted_at: number | null;
  included_at: number | null;
  last_block: number | null;
}

export interface SqliteHandle {
  readonly raw: BetterSqlite3Database;
  close(): void;
}

export function openSqlite(dbUrl: string): SqliteHandle {
  const path = dbUrl.startsWith('file:') ? dbUrl.slice('file:'.length) : dbUrl;
  const raw = new BetterSqlite3(path);
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  applyMigrations(raw);
  return {
    raw,
    close: () => raw.close(),
  };
}

function serializeState(s: SignedState): string {
  return JSON.stringify({
    state: {
      channelId: s.state.channelId,
      version: s.state.version.toString(),
      balanceA: s.state.balanceA.toString(),
      balanceB: s.state.balanceB.toString(),
      finalized: s.state.finalized,
      htlcs: s.state.htlcs.map((h) => ({
        id: h.id,
        direction: h.direction,
        amount: h.amount.toString(),
        paymentHash: h.paymentHash,
        expiryMs: h.expiryMs.toString(),
      })),
    },
    sigA: s.sigA,
    sigB: s.sigB,
  });
}

function deserializeState(json: string): SignedState {
  const parsed = JSON.parse(json) as {
    state: {
      channelId: ChannelId;
      version: string;
      balanceA: string;
      balanceB: string;
      finalized: boolean;
      htlcs: Array<{
        id: Hex;
        direction: 'AtoB' | 'BtoA';
        amount: string;
        paymentHash: Hex;
        expiryMs: string;
      }>;
    };
    sigA: SignedState['sigA'];
    sigB: SignedState['sigB'];
  };
  return {
    state: {
      channelId: parsed.state.channelId,
      version: BigInt(parsed.state.version),
      balanceA: BigInt(parsed.state.balanceA),
      balanceB: BigInt(parsed.state.balanceB),
      finalized: parsed.state.finalized,
      htlcs: parsed.state.htlcs.map((h) => ({
        id: h.id,
        direction: h.direction,
        amount: BigInt(h.amount),
        paymentHash: h.paymentHash,
        expiryMs: BigInt(h.expiryMs),
      })),
    },
    sigA: parsed.sigA,
    sigB: parsed.sigB,
  };
}

export class SqliteStateStore implements PlainStateStore {
  private readonly insert: BetterSqlite3.Statement<
    [string, string, string, string, string, number]
  >;
  private readonly latestStmt: BetterSqlite3.Statement<[string]>;
  private readonly listStmt: BetterSqlite3.Statement<[]>;

  constructor(private readonly db: BetterSqlite3Database) {
    this.insert = db.prepare(
      `INSERT INTO signed_states (channel_id, version, state_json, sig_a, sig_b, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_id, version) DO NOTHING`,
    );
    this.latestStmt = db.prepare(
      `SELECT channel_id, version, state_json, sig_a, sig_b, recorded_at
       FROM signed_states
       WHERE channel_id = ?
       ORDER BY CAST(version AS INTEGER) DESC
       LIMIT 1`,
    );
    this.listStmt = db.prepare(
      `SELECT s1.channel_id, s1.version, s1.state_json, s1.sig_a, s1.sig_b, s1.recorded_at
       FROM signed_states s1
       INNER JOIN (
         SELECT channel_id, MAX(CAST(version AS INTEGER)) AS max_v
         FROM signed_states
         GROUP BY channel_id
       ) s2 ON s1.channel_id = s2.channel_id
         AND CAST(s1.version AS INTEGER) = s2.max_v`,
    );
  }

  async put(state: SignedState): Promise<void> {
    this.insert.run(
      state.state.channelId,
      state.state.version.toString(),
      serializeState(state),
      JSON.stringify(state.sigA),
      JSON.stringify(state.sigB),
      Date.now(),
    );
  }

  async latest(channelId: ChannelId): Promise<SignedState | undefined> {
    const row = this.latestStmt.get(channelId) as SignedStateRow | undefined;
    if (!row) return undefined;
    return deserializeState(row.state_json);
  }

  async list(): Promise<readonly SignedState[]> {
    const rows = this.listStmt.all() as SignedStateRow[];
    return rows.map((r) => deserializeState(r.state_json));
  }
}

export class ObservationRepo {
  private readonly upsert: BetterSqlite3.Statement;
  private readonly markSubmittedStmt: BetterSqlite3.Statement<[string, number, string]>;
  private readonly markIncludedStmt: BetterSqlite3.Statement<[number, string]>;
  private readonly pendingStmt: BetterSqlite3.Statement<[number]>;
  private readonly setMetaStmt: BetterSqlite3.Statement<[string, string]>;
  private readonly getMetaStmt: BetterSqlite3.Statement<[string]>;
  private readonly getStmt: BetterSqlite3.Statement<[string]>;

  constructor(private readonly db: BetterSqlite3Database) {
    this.upsert = db.prepare(
      `INSERT INTO watchtower_observations
        (channel_id, posted_version, posted_at, our_latest_version, action_taken, submit_by, tx_hash, submitted_at, included_at, last_block)
       VALUES (@channelId, @postedVersion, @postedAt, @ourLatestVersion, @actionTaken, @submitBy, @txHash, @submittedAt, @includedAt, @lastBlock)
       ON CONFLICT(channel_id) DO UPDATE SET
         posted_version = excluded.posted_version,
         posted_at      = excluded.posted_at,
         our_latest_version = excluded.our_latest_version,
         action_taken   = excluded.action_taken,
         submit_by      = excluded.submit_by,
         last_block     = excluded.last_block`,
    );
    this.markSubmittedStmt = db.prepare(
      'UPDATE watchtower_observations SET tx_hash = ?, submitted_at = ? WHERE channel_id = ?',
    );
    this.markIncludedStmt = db.prepare(
      'UPDATE watchtower_observations SET included_at = ? WHERE channel_id = ?',
    );
    this.pendingStmt = db.prepare(
      `SELECT * FROM watchtower_observations
       WHERE action_taken = 'penalize' AND tx_hash IS NULL AND submit_by <= ?
       ORDER BY submit_by ASC`,
    );
    this.setMetaStmt = db.prepare(
      `INSERT INTO watchtower_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    this.getMetaStmt = db.prepare('SELECT value FROM watchtower_meta WHERE key = ?');
    this.getStmt = db.prepare('SELECT * FROM watchtower_observations WHERE channel_id = ?');
  }

  record(obs: Observation): void {
    this.upsert.run({
      channelId: obs.channelId,
      postedVersion: obs.postedVersion.toString(),
      postedAt: obs.postedAt,
      ourLatestVersion: obs.ourLatestVersion.toString(),
      actionTaken: obs.actionTaken,
      submitBy: obs.submitBy,
      txHash: obs.txHash ?? null,
      submittedAt: obs.submittedAt ?? null,
      includedAt: obs.includedAt ?? null,
      lastBlock: obs.lastBlock ?? null,
    });
  }

  markSubmitted(channelId: ChannelId, txHash: Hex, submittedAt: number): void {
    this.markSubmittedStmt.run(txHash, submittedAt, channelId);
  }

  markIncluded(channelId: ChannelId, includedAt: number): void {
    this.markIncludedStmt.run(includedAt, channelId);
  }

  pendingObservations(now: number): readonly Observation[] {
    const rows = this.pendingStmt.all(now) as ObservationRow[];
    return rows.map((r) => observationFromRow(r));
  }

  get(channelId: ChannelId): Observation | undefined {
    const row = this.getStmt.get(channelId) as ObservationRow | undefined;
    if (!row) return undefined;
    return observationFromRow(row);
  }

  setMeta(key: string, value: string): void {
    this.setMetaStmt.run(key, value);
  }

  getMeta(key: string): string | undefined {
    const row = this.getMetaStmt.get(key) as { value: string } | undefined;
    return row?.value;
  }
}

function observationFromRow(r: ObservationRow): Observation {
  return {
    channelId: r.channel_id as ChannelId,
    postedVersion: BigInt(r.posted_version),
    postedAt: r.posted_at,
    ourLatestVersion: BigInt(r.our_latest_version),
    actionTaken: r.action_taken as ObservationAction,
    submitBy: r.submit_by,
    ...(r.tx_hash ? { txHash: r.tx_hash as Hex } : {}),
    ...(r.submitted_at !== null ? { submittedAt: r.submitted_at } : {}),
    ...(r.included_at !== null ? { includedAt: r.included_at } : {}),
    ...(r.last_block !== null ? { lastBlock: r.last_block } : {}),
  };
}
