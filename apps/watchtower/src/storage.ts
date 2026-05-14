import type { ChannelId, SignedState } from '@inferenceroom/pico-protocol';
import { deserializeSignedState, serializeSignedState } from '@inferenceroom/pico-sdk';
import Database from 'better-sqlite3';

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

export interface WatchtowerObservation {
  readonly channelId: ChannelId;
  readonly postedVersion: bigint;
  readonly postedAtMs: number;
  readonly ourLatestVersion: bigint;
  readonly actionTaken: 'noop' | 'penalize';
  readonly reason?: string;
  readonly txHash?: `0x${string}`;
  readonly submittedAtMs?: number;
  readonly includedAtMs?: number;
  readonly createdAtMs: number;
}

export interface InFlightTx {
  readonly channelId: ChannelId;
  readonly txHash: `0x${string}`;
  readonly submittedAtMs: number;
  readonly nonce: number;
  readonly maxFeePerGas: bigint;
  readonly attempts: number;
  readonly observationId?: number;
}

/** H6 preimage cache row: hubs forward seen preimages so the watchtower can
 *  build claim transactions if a channel ever needs on-chain HTLC settlement.
 *  Indexed by paymentHash so the resolver can look up by-HTLC at proof time. */
export interface PreimageRecord {
  readonly paymentHash: `0x${string}`;
  readonly preimage: `0x${string}`;
  readonly learnedAtMs: number;
}

export interface WatchtowerStore {
  init(): void;
  putSignedState(state: SignedState): void;
  loadAllSignedStates(): readonly SignedState[];
  recordObservation(obs: WatchtowerObservation): number;
  markObservationSubmitted(rowid: number, txHash: `0x${string}`, submittedAtMs: number): void;
  markObservationIncluded(rowid: number, includedAtMs: number): void;
  putInFlight(row: InFlightTx): void;
  getInFlight(channelId: ChannelId): InFlightTx | undefined;
  listInFlight(): readonly InFlightTx[];
  clearInFlight(channelId: ChannelId): void;
  putMeta(key: string, value: string): void;
  getMeta(key: string): string | undefined;
  /** H6: persist a preimage learned from a hub or client. Idempotent on hash. */
  putPreimage(record: PreimageRecord): void;
  /** H6: look up a preimage by its payment hash. Returns undefined if unknown. */
  getPreimage(paymentHash: `0x${string}`): PreimageRecord | undefined;
  /** Quick liveness probe: throws on broken DB; returns true on success. */
  ping(): boolean;
  close(): void;
}

type DbHandle = Database.Database;

interface SignedStateRow {
  readonly channel_id: string;
  readonly version: string;
  readonly state_json: string;
  readonly sig_a_json: string;
  readonly sig_b_json: string;
  readonly updated_at_ms: number;
}

interface InFlightRow {
  readonly channel_id: string;
  readonly tx_hash: string;
  readonly submitted_at_ms: number;
  readonly nonce: number;
  readonly max_fee_per_gas: string;
  readonly attempts: number;
  readonly observation_id: number | null;
}

interface MetaRow {
  readonly value: string;
}

export class SqliteWatchtowerStore implements WatchtowerStore {
  private readonly db: DbHandle;
  private readonly ownsDb: boolean;
  private initialized = false;

  private putSignedStateStmt?: Database.Statement;
  private loadAllSignedStatesStmt?: Database.Statement;
  private recordObservationStmt?: Database.Statement;
  private markObservationSubmittedStmt?: Database.Statement;
  private markObservationIncludedStmt?: Database.Statement;
  private putInFlightStmt?: Database.Statement;
  private getInFlightStmt?: Database.Statement;
  private listInFlightStmt?: Database.Statement;
  private clearInFlightStmt?: Database.Statement;
  private putMetaStmt?: Database.Statement;
  private getMetaStmt?: Database.Statement;
  private putPreimageStmt?: Database.Statement;
  private getPreimageStmt?: Database.Statement;

  constructor(target: string | DbHandle) {
    if (typeof target === 'string') {
      this.db = new Database(target);
      this.ownsDb = true;
      if (target !== ':memory:') {
        this.db.pragma('journal_mode = WAL');
      }
    } else {
      this.db = target;
      this.ownsDb = false;
    }
  }

  init(): void {
    if (this.initialized) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS signed_states (
        channel_id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        state_json TEXT NOT NULL,
        sig_a_json TEXT NOT NULL,
        sig_b_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS watchtower_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        posted_version TEXT NOT NULL,
        posted_at_ms INTEGER NOT NULL,
        our_latest_version TEXT NOT NULL,
        action_taken TEXT NOT NULL,
        reason TEXT,
        tx_hash TEXT,
        submitted_at_ms INTEGER,
        included_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS in_flight_txs (
        channel_id TEXT PRIMARY KEY,
        tx_hash TEXT NOT NULL,
        submitted_at_ms INTEGER NOT NULL,
        nonce INTEGER NOT NULL,
        max_fee_per_gas TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        observation_id INTEGER
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS preimages (
        payment_hash TEXT PRIMARY KEY,
        preimage TEXT NOT NULL,
        learned_at_ms INTEGER NOT NULL
      );
    `);
    this.prepareStatements();
    this.initialized = true;
  }

  putPreimage(record: PreimageRecord): void {
    const stmt = this.requirePutPreimage();
    stmt.run({
      payment_hash: record.paymentHash,
      preimage: record.preimage,
      learned_at_ms: record.learnedAtMs,
    });
  }

  getPreimage(paymentHash: `0x${string}`): PreimageRecord | undefined {
    const stmt = this.requireGetPreimage();
    const row = stmt.get({ payment_hash: paymentHash }) as
      | { payment_hash: string; preimage: string; learned_at_ms: number }
      | undefined;
    if (!row) return undefined;
    return {
      paymentHash: row.payment_hash as `0x${string}`,
      preimage: row.preimage as `0x${string}`,
      learnedAtMs: row.learned_at_ms,
    };
  }

  putSignedState(state: SignedState): void {
    const stmt = this.requirePutSignedState();
    const serialized = serializeSignedState(state);
    stmt.run({
      channel_id: state.state.channelId,
      version: state.state.version.toString(),
      state_json: JSON.stringify(serialized.state),
      sig_a_json: JSON.stringify(serialized.sigA),
      sig_b_json: JSON.stringify(serialized.sigB),
      updated_at_ms: Date.now(),
    });
  }

  loadAllSignedStates(): readonly SignedState[] {
    const stmt = this.requireLoadAll();
    const rows = stmt.all() as SignedStateRow[];
    return rows.map((row) =>
      deserializeSignedState({
        state: JSON.parse(row.state_json),
        sigA: JSON.parse(row.sig_a_json),
        sigB: JSON.parse(row.sig_b_json),
      }),
    );
  }

  recordObservation(obs: WatchtowerObservation): number {
    const stmt = this.requireRecordObservation();
    const result = stmt.run({
      channel_id: obs.channelId,
      posted_version: obs.postedVersion.toString(),
      posted_at_ms: obs.postedAtMs,
      our_latest_version: obs.ourLatestVersion.toString(),
      action_taken: obs.actionTaken,
      reason: obs.reason ?? null,
      tx_hash: obs.txHash ?? null,
      submitted_at_ms: obs.submittedAtMs ?? null,
      included_at_ms: obs.includedAtMs ?? null,
      created_at_ms: obs.createdAtMs,
    });
    return Number(result.lastInsertRowid);
  }

  markObservationSubmitted(rowid: number, txHash: `0x${string}`, submittedAtMs: number): void {
    const stmt = this.requireMarkSubmitted();
    stmt.run({ id: rowid, tx_hash: txHash, submitted_at_ms: submittedAtMs });
  }

  markObservationIncluded(rowid: number, includedAtMs: number): void {
    const stmt = this.requireMarkIncluded();
    stmt.run({ id: rowid, included_at_ms: includedAtMs });
  }

  putInFlight(row: InFlightTx): void {
    const stmt = this.requirePutInFlight();
    stmt.run({
      channel_id: row.channelId,
      tx_hash: row.txHash,
      submitted_at_ms: row.submittedAtMs,
      nonce: row.nonce,
      max_fee_per_gas: row.maxFeePerGas.toString(),
      attempts: row.attempts,
      observation_id: row.observationId ?? null,
    });
  }

  getInFlight(channelId: ChannelId): InFlightTx | undefined {
    const stmt = this.requireGetInFlight();
    const row = stmt.get({ channel_id: channelId }) as InFlightRow | undefined;
    if (!row) return undefined;
    return {
      channelId: row.channel_id as ChannelId,
      txHash: row.tx_hash as `0x${string}`,
      submittedAtMs: row.submitted_at_ms,
      nonce: row.nonce,
      maxFeePerGas: BigInt(row.max_fee_per_gas),
      attempts: row.attempts,
      ...(row.observation_id !== null ? { observationId: row.observation_id } : {}),
    };
  }

  listInFlight(): readonly InFlightTx[] {
    const stmt = this.requireListInFlight();
    const rows = stmt.all() as InFlightRow[];
    return rows.map((row) => ({
      channelId: row.channel_id as ChannelId,
      txHash: row.tx_hash as `0x${string}`,
      submittedAtMs: row.submitted_at_ms,
      nonce: row.nonce,
      maxFeePerGas: BigInt(row.max_fee_per_gas),
      attempts: row.attempts,
      ...(row.observation_id !== null ? { observationId: row.observation_id } : {}),
    }));
  }

  clearInFlight(channelId: ChannelId): void {
    const stmt = this.requireClearInFlight();
    stmt.run({ channel_id: channelId });
  }

  putMeta(key: string, value: string): void {
    const stmt = this.requirePutMeta();
    stmt.run({ key, value });
  }

  getMeta(key: string): string | undefined {
    const stmt = this.requireGetMeta();
    const row = stmt.get({ key }) as MetaRow | undefined;
    return row?.value;
  }

  ping(): boolean {
    if (!this.db.open) throw new Error('watchtower SQLite db is not open');
    const row = this.db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
    if (!row || row.ok !== 1) throw new Error('watchtower SQLite ping returned unexpected result');
    return true;
  }

  close(): void {
    if (this.ownsDb && this.db.open) {
      this.db.close();
    }
  }

  private prepareStatements(): void {
    this.putSignedStateStmt = this.db.prepare(`
      INSERT INTO signed_states (channel_id, version, state_json, sig_a_json, sig_b_json, updated_at_ms)
      VALUES (@channel_id, @version, @state_json, @sig_a_json, @sig_b_json, @updated_at_ms)
      ON CONFLICT(channel_id) DO UPDATE SET
        version = excluded.version,
        state_json = excluded.state_json,
        sig_a_json = excluded.sig_a_json,
        sig_b_json = excluded.sig_b_json,
        updated_at_ms = excluded.updated_at_ms
      WHERE CAST(excluded.version AS INTEGER) > CAST(signed_states.version AS INTEGER)
    `);
    this.loadAllSignedStatesStmt = this.db.prepare(`
      SELECT channel_id, version, state_json, sig_a_json, sig_b_json, updated_at_ms
      FROM signed_states
    `);
    this.recordObservationStmt = this.db.prepare(`
      INSERT INTO watchtower_observations (
        channel_id, posted_version, posted_at_ms, our_latest_version,
        action_taken, reason, tx_hash, submitted_at_ms, included_at_ms, created_at_ms
      ) VALUES (
        @channel_id, @posted_version, @posted_at_ms, @our_latest_version,
        @action_taken, @reason, @tx_hash, @submitted_at_ms, @included_at_ms, @created_at_ms
      )
    `);
    this.markObservationSubmittedStmt = this.db.prepare(`
      UPDATE watchtower_observations
      SET tx_hash = @tx_hash, submitted_at_ms = @submitted_at_ms
      WHERE id = @id
    `);
    this.markObservationIncludedStmt = this.db.prepare(`
      UPDATE watchtower_observations
      SET included_at_ms = @included_at_ms
      WHERE id = @id
    `);
    this.putInFlightStmt = this.db.prepare(`
      INSERT INTO in_flight_txs (channel_id, tx_hash, submitted_at_ms, nonce, max_fee_per_gas, attempts, observation_id)
      VALUES (@channel_id, @tx_hash, @submitted_at_ms, @nonce, @max_fee_per_gas, @attempts, @observation_id)
      ON CONFLICT(channel_id) DO UPDATE SET
        tx_hash = excluded.tx_hash,
        submitted_at_ms = excluded.submitted_at_ms,
        nonce = excluded.nonce,
        max_fee_per_gas = excluded.max_fee_per_gas,
        attempts = excluded.attempts,
        observation_id = COALESCE(excluded.observation_id, in_flight_txs.observation_id)
    `);
    this.getInFlightStmt = this.db.prepare(`
      SELECT channel_id, tx_hash, submitted_at_ms, nonce, max_fee_per_gas, attempts, observation_id
      FROM in_flight_txs
      WHERE channel_id = @channel_id
    `);
    this.listInFlightStmt = this.db.prepare(`
      SELECT channel_id, tx_hash, submitted_at_ms, nonce, max_fee_per_gas, attempts, observation_id
      FROM in_flight_txs
    `);
    this.clearInFlightStmt = this.db.prepare(`
      DELETE FROM in_flight_txs WHERE channel_id = @channel_id
    `);
    this.putMetaStmt = this.db.prepare(`
      INSERT INTO meta (key, value) VALUES (@key, @value)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    this.getMetaStmt = this.db.prepare(`
      SELECT value FROM meta WHERE key = @key
    `);
    this.putPreimageStmt = this.db.prepare(`
      INSERT INTO preimages (payment_hash, preimage, learned_at_ms)
      VALUES (@payment_hash, @preimage, @learned_at_ms)
      ON CONFLICT(payment_hash) DO NOTHING
    `);
    this.getPreimageStmt = this.db.prepare(`
      SELECT payment_hash, preimage, learned_at_ms FROM preimages WHERE payment_hash = @payment_hash
    `);
  }

  private requirePutSignedState(): Database.Statement {
    if (!this.putSignedStateStmt) throw new Error('SqliteWatchtowerStore: init() not called');
    return this.putSignedStateStmt;
  }
  private requireLoadAll(): Database.Statement {
    if (!this.loadAllSignedStatesStmt) throw new Error('SqliteWatchtowerStore: init() not called');
    return this.loadAllSignedStatesStmt;
  }
  private requireRecordObservation(): Database.Statement {
    if (!this.recordObservationStmt) throw new Error('SqliteWatchtowerStore: init() not called');
    return this.recordObservationStmt;
  }
  private requireMarkSubmitted(): Database.Statement {
    if (!this.markObservationSubmittedStmt)
      throw new Error('SqliteWatchtowerStore: init() not called');
    return this.markObservationSubmittedStmt;
  }
  private requireMarkIncluded(): Database.Statement {
    if (!this.markObservationIncludedStmt)
      throw new Error('SqliteWatchtowerStore: init() not called');
    return this.markObservationIncludedStmt;
  }
  private requirePutInFlight(): Database.Statement {
    if (!this.putInFlightStmt) throw new Error('SqliteWatchtowerStore: init() not called');
    return this.putInFlightStmt;
  }
  private requireGetInFlight(): Database.Statement {
    if (!this.getInFlightStmt) throw new Error('SqliteWatchtowerStore: init() not called');
    return this.getInFlightStmt;
  }
  private requireListInFlight(): Database.Statement {
    if (!this.listInFlightStmt) throw new Error('SqliteWatchtowerStore: init() not called');
    return this.listInFlightStmt;
  }
  private requireClearInFlight(): Database.Statement {
    if (!this.clearInFlightStmt) throw new Error('SqliteWatchtowerStore: init() not called');
    return this.clearInFlightStmt;
  }
  private requirePutMeta(): Database.Statement {
    if (!this.putMetaStmt) throw new Error('SqliteWatchtowerStore: init() not called');
    return this.putMetaStmt;
  }
  private requireGetMeta(): Database.Statement {
    if (!this.getMetaStmt) throw new Error('SqliteWatchtowerStore: init() not called');
    return this.getMetaStmt;
  }
  private requirePutPreimage(): Database.Statement {
    if (!this.putPreimageStmt) throw new Error('SqliteWatchtowerStore: init() not called');
    return this.putPreimageStmt;
  }
  private requireGetPreimage(): Database.Statement {
    if (!this.getPreimageStmt) throw new Error('SqliteWatchtowerStore: init() not called');
    return this.getPreimageStmt;
  }
}
