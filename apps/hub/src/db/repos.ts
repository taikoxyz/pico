import type { Channel, ChannelId, Hex, SignedState } from '@tainnel/protocol';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import {
  channelToRow,
  deserializeSignedState,
  rowToChannel,
  serializeSignedState,
} from './serialize.js';

export type HtlcStatus = 'pending' | 'settled' | 'failed' | 'expired';
export type HtlcDirection = 'AtoB' | 'BtoA';

export interface HtlcRow {
  readonly id: Hex;
  readonly channelId: ChannelId;
  readonly paymentHash: Hex;
  readonly amount: bigint;
  readonly expiryMs: bigint;
  readonly direction: HtlcDirection;
  readonly status: HtlcStatus;
  readonly settledPreimage?: Hex;
  readonly createdAt: number;
}

export type PaymentStatus = 'pending' | 'settled' | 'failed';

export interface PaymentRow {
  readonly id: Hex;
  readonly sourceChannel: ChannelId;
  readonly destChannel?: ChannelId;
  readonly amount: bigint;
  readonly paymentHash: Hex;
  readonly status: PaymentStatus;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly feePaid?: bigint;
}

export class ChannelRepo {
  private readonly upsertStmt;
  private readonly getStmt;
  private readonly listStmt;
  private readonly setStatusStmt;

  constructor(db: BetterSqlite3Database) {
    this.upsertStmt = db.prepare(
      `INSERT INTO channels (id, chain_id, contract, user_a, user_b, token, status, opened_at, dispute_window_ms)
       VALUES (@id, @chain_id, @contract, @user_a, @user_b, @token, @status, @opened_at, @dispute_window_ms)
       ON CONFLICT(id) DO UPDATE SET
         chain_id = excluded.chain_id,
         contract = excluded.contract,
         user_a   = excluded.user_a,
         user_b   = excluded.user_b,
         token    = excluded.token,
         status   = excluded.status,
         opened_at = excluded.opened_at,
         dispute_window_ms = excluded.dispute_window_ms`,
    );
    this.getStmt = db.prepare('SELECT * FROM channels WHERE id = ?');
    this.listStmt = db.prepare('SELECT * FROM channels');
    this.setStatusStmt = db.prepare('UPDATE channels SET status = ? WHERE id = ?');
  }

  upsert(channel: Channel): void {
    this.upsertStmt.run(channelToRow(channel));
  }

  get(id: ChannelId): Channel | undefined {
    const row = this.getStmt.get(id) as Parameters<typeof rowToChannel>[0] | undefined;
    return row ? rowToChannel(row) : undefined;
  }

  list(): readonly Channel[] {
    const rows = this.listStmt.all() as Array<Parameters<typeof rowToChannel>[0]>;
    return rows.map(rowToChannel);
  }

  setStatus(id: ChannelId, status: Channel['status']): void {
    this.setStatusStmt.run(status, id);
  }
}

export class StateRepo {
  private readonly insertStmt;
  private readonly latestStmt;
  private readonly listStmt;

  constructor(db: BetterSqlite3Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO signed_states (channel_id, version, state_json, sig_a, sig_b, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_id, version) DO NOTHING`,
    );
    this.latestStmt = db.prepare(
      `SELECT state_json FROM signed_states
       WHERE channel_id = ?
       ORDER BY CAST(version AS INTEGER) DESC
       LIMIT 1`,
    );
    this.listStmt = db.prepare(
      `SELECT state_json FROM signed_states WHERE channel_id = ?
       ORDER BY CAST(version AS INTEGER) ASC`,
    );
  }

  record(channelId: ChannelId, signed: SignedState): void {
    this.insertStmt.run(
      channelId,
      signed.state.version.toString(),
      serializeSignedState(signed),
      JSON.stringify(signed.sigA),
      JSON.stringify(signed.sigB),
      Date.now(),
    );
  }

  latest(channelId: ChannelId): SignedState | undefined {
    const row = this.latestStmt.get(channelId) as { state_json: string } | undefined;
    return row ? deserializeSignedState(row.state_json) : undefined;
  }

  list(channelId: ChannelId): readonly SignedState[] {
    const rows = this.listStmt.all(channelId) as Array<{ state_json: string }>;
    return rows.map((r) => deserializeSignedState(r.state_json));
  }
}

interface HtlcSqlRow {
  id: string;
  channel_id: string;
  payment_hash: string;
  amount: string;
  expiry_ms: string;
  direction: string;
  status: string;
  settled_preimage: string | null;
  created_at: number;
}

function htlcFromRow(r: HtlcSqlRow): HtlcRow {
  return {
    id: r.id as Hex,
    channelId: r.channel_id as ChannelId,
    paymentHash: r.payment_hash as Hex,
    amount: BigInt(r.amount),
    expiryMs: BigInt(r.expiry_ms),
    direction: r.direction as HtlcDirection,
    status: r.status as HtlcStatus,
    ...(r.settled_preimage ? { settledPreimage: r.settled_preimage as Hex } : {}),
    createdAt: r.created_at,
  };
}

export class HtlcRepo {
  private readonly upsertStmt;
  private readonly getStmt;
  private readonly byChannelStmt;
  private readonly setStatusStmt;
  private readonly setStatusWithPreimageStmt;
  private readonly pendingStmt;

  constructor(db: BetterSqlite3Database) {
    this.upsertStmt = db.prepare(
      `INSERT INTO htlcs (id, channel_id, payment_hash, amount, expiry_ms, direction, status, settled_preimage, created_at)
       VALUES (@id, @channel_id, @payment_hash, @amount, @expiry_ms, @direction, @status, @settled_preimage, @created_at)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         settled_preimage = excluded.settled_preimage`,
    );
    this.getStmt = db.prepare('SELECT * FROM htlcs WHERE id = ?');
    this.byChannelStmt = db.prepare('SELECT * FROM htlcs WHERE channel_id = ?');
    this.setStatusStmt = db.prepare('UPDATE htlcs SET status = ? WHERE id = ?');
    this.setStatusWithPreimageStmt = db.prepare(
      'UPDATE htlcs SET status = ?, settled_preimage = ? WHERE id = ?',
    );
    this.pendingStmt = db.prepare(
      "SELECT * FROM htlcs WHERE channel_id = ? AND status = 'pending'",
    );
  }

  upsert(h: HtlcRow): void {
    this.upsertStmt.run({
      id: h.id,
      channel_id: h.channelId,
      payment_hash: h.paymentHash,
      amount: h.amount.toString(),
      expiry_ms: h.expiryMs.toString(),
      direction: h.direction,
      status: h.status,
      settled_preimage: h.settledPreimage ?? null,
      created_at: h.createdAt,
    });
  }

  get(id: Hex): HtlcRow | undefined {
    const row = this.getStmt.get(id) as HtlcSqlRow | undefined;
    return row ? htlcFromRow(row) : undefined;
  }

  byChannel(channelId: ChannelId): readonly HtlcRow[] {
    const rows = this.byChannelStmt.all(channelId) as HtlcSqlRow[];
    return rows.map(htlcFromRow);
  }

  setStatus(id: Hex, status: HtlcStatus, preimage?: Hex): void {
    if (preimage) {
      this.setStatusWithPreimageStmt.run(status, preimage, id);
    } else {
      this.setStatusStmt.run(status, id);
    }
  }

  pendingByChannel(channelId: ChannelId): readonly HtlcRow[] {
    const rows = this.pendingStmt.all(channelId) as HtlcSqlRow[];
    return rows.map(htlcFromRow);
  }
}

interface PaymentSqlRow {
  id: string;
  source_channel: string;
  dest_channel: string | null;
  amount: string;
  payment_hash: string;
  status: string;
  started_at: number;
  completed_at: number | null;
  fee_paid: string | null;
}

function paymentFromRow(r: PaymentSqlRow): PaymentRow {
  return {
    id: r.id as Hex,
    sourceChannel: r.source_channel as ChannelId,
    ...(r.dest_channel ? { destChannel: r.dest_channel as ChannelId } : {}),
    amount: BigInt(r.amount),
    paymentHash: r.payment_hash as Hex,
    status: r.status as PaymentStatus,
    startedAt: r.started_at,
    ...(r.completed_at !== null ? { completedAt: r.completed_at } : {}),
    ...(r.fee_paid !== null ? { feePaid: BigInt(r.fee_paid) } : {}),
  };
}

export class PaymentRepo {
  private readonly insertStmt;
  private readonly completeStmt;
  private readonly failStmt;
  private readonly byPaymentHashStmt;
  private readonly getStmt;

  constructor(db: BetterSqlite3Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO payments (id, source_channel, dest_channel, amount, payment_hash, status, started_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    );
    this.completeStmt = db.prepare(
      "UPDATE payments SET status = 'settled', completed_at = ?, fee_paid = ? WHERE id = ?",
    );
    this.failStmt = db.prepare(
      "UPDATE payments SET status = 'failed', completed_at = ? WHERE id = ?",
    );
    this.byPaymentHashStmt = db.prepare('SELECT * FROM payments WHERE payment_hash = ? LIMIT 1');
    this.getStmt = db.prepare('SELECT * FROM payments WHERE id = ?');
  }

  start(
    p: Pick<PaymentRow, 'id' | 'sourceChannel' | 'destChannel' | 'amount' | 'paymentHash'>,
  ): void {
    this.insertStmt.run(
      p.id,
      p.sourceChannel,
      p.destChannel ?? null,
      p.amount.toString(),
      p.paymentHash,
      Date.now(),
    );
  }

  complete(id: Hex, feePaid: bigint): void {
    this.completeStmt.run(Date.now(), feePaid.toString(), id);
  }

  fail(id: Hex): void {
    this.failStmt.run(Date.now(), id);
  }

  byPaymentHash(hash: Hex): PaymentRow | undefined {
    const row = this.byPaymentHashStmt.get(hash) as PaymentSqlRow | undefined;
    return row ? paymentFromRow(row) : undefined;
  }

  get(id: Hex): PaymentRow | undefined {
    const row = this.getStmt.get(id) as PaymentSqlRow | undefined;
    return row ? paymentFromRow(row) : undefined;
  }
}

export class NonceRepo {
  private readonly insertStmt;
  private readonly seenStmt;
  private readonly purgeStmt;

  constructor(db: BetterSqlite3Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO seen_nonces (nonce, addr, seen_at) VALUES (?, ?, ?)
       ON CONFLICT(nonce) DO NOTHING`,
    );
    this.seenStmt = db.prepare('SELECT 1 FROM seen_nonces WHERE nonce = ? AND seen_at >= ?');
    this.purgeStmt = db.prepare('DELETE FROM seen_nonces WHERE seen_at < ?');
  }

  seenWithin24h(nonce: string): boolean {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return Boolean(this.seenStmt.get(nonce, cutoff));
  }

  record(nonce: string, addr: string): void {
    this.insertStmt.run(nonce, addr, Date.now());
  }

  purgeOlderThan(timestamp: number): number {
    return this.purgeStmt.run(timestamp).changes;
  }
}

export interface DisputeObservation {
  readonly channelId: ChannelId;
  readonly attackerVersion: bigint;
  readonly ourVersion: bigint;
  readonly observedAt: number;
}

export class DisputeRepo {
  private readonly upsertStmt;
  private readonly markRespondedStmt;
  private readonly getStmt;

  constructor(db: BetterSqlite3Database) {
    this.upsertStmt = db.prepare(
      `INSERT INTO disputes (channel_id, attacker_version, our_version, observed_at)
       VALUES (@channelId, @attackerVersion, @ourVersion, @observedAt)
       ON CONFLICT(channel_id) DO UPDATE SET
         attacker_version = excluded.attacker_version,
         our_version = excluded.our_version,
         observed_at = excluded.observed_at`,
    );
    this.markRespondedStmt = db.prepare(
      'UPDATE disputes SET responded_at = ?, tx_hash = ? WHERE channel_id = ?',
    );
    this.getStmt = db.prepare('SELECT * FROM disputes WHERE channel_id = ?');
  }

  record(o: DisputeObservation): void {
    this.upsertStmt.run({
      channelId: o.channelId,
      attackerVersion: o.attackerVersion.toString(),
      ourVersion: o.ourVersion.toString(),
      observedAt: o.observedAt,
    });
  }

  markResponded(channelId: ChannelId, txHash: Hex, respondedAt: number): void {
    this.markRespondedStmt.run(respondedAt, txHash, channelId);
  }

  get(channelId: ChannelId): DisputeObservation | undefined {
    const row = this.getStmt.get(channelId) as
      | {
          channel_id: string;
          attacker_version: string;
          our_version: string;
          observed_at: number;
        }
      | undefined;
    if (!row) return undefined;
    return {
      channelId: row.channel_id as ChannelId,
      attackerVersion: BigInt(row.attacker_version),
      ourVersion: BigInt(row.our_version),
      observedAt: row.observed_at,
    };
  }
}
