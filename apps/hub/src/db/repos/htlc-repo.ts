import type { ChannelId, Htlc, HtlcId, PaymentHash } from '@tainnel/protocol';
import type { DbDriver } from '../types.js';

export type HtlcLifecycleState = 'inflight' | 'settled' | 'failed' | 'expired';

export interface HtlcRecord {
  readonly htlc: Htlc;
  readonly channelId: ChannelId;
  readonly state: HtlcLifecycleState;
  readonly incomingChannelId?: ChannelId;
  readonly outgoingChannelId?: ChannelId;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface HtlcRow {
  readonly id: string;
  readonly channel_id: string;
  readonly direction: 'AtoB' | 'BtoA';
  readonly amount: string;
  readonly payment_hash: string;
  readonly expiry_ms: string;
  readonly state: HtlcLifecycleState;
  readonly incoming_channel_id: string | null;
  readonly outgoing_channel_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

function rowToRecord(r: HtlcRow): HtlcRecord {
  return {
    htlc: {
      id: r.id as HtlcId,
      direction: r.direction,
      amount: BigInt(r.amount),
      paymentHash: r.payment_hash as PaymentHash,
      expiryMs: BigInt(r.expiry_ms),
    },
    channelId: r.channel_id as ChannelId,
    state: r.state,
    ...(r.incoming_channel_id !== null
      ? { incomingChannelId: r.incoming_channel_id as ChannelId }
      : {}),
    ...(r.outgoing_channel_id !== null
      ? { outgoingChannelId: r.outgoing_channel_id as ChannelId }
      : {}),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export interface SaveHtlcInput {
  readonly htlc: Htlc;
  readonly channelId: ChannelId;
  readonly state: HtlcLifecycleState;
  readonly incomingChannelId?: ChannelId;
  readonly outgoingChannelId?: ChannelId;
}

export class HtlcRepo {
  constructor(private readonly db: DbDriver) {}

  async save(input: SaveHtlcInput): Promise<void> {
    const now = String(Date.now());
    await this.db.exec(
      `INSERT INTO htlcs (id, channel_id, direction, amount, payment_hash, expiry_ms,
                          state, incoming_channel_id, outgoing_channel_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         state = excluded.state,
         incoming_channel_id = excluded.incoming_channel_id,
         outgoing_channel_id = excluded.outgoing_channel_id,
         updated_at = excluded.updated_at`,
      [
        input.htlc.id,
        input.channelId,
        input.htlc.direction,
        input.htlc.amount.toString(),
        input.htlc.paymentHash,
        input.htlc.expiryMs.toString(),
        input.state,
        input.incomingChannelId ?? null,
        input.outgoingChannelId ?? null,
        now,
        now,
      ],
    );
  }

  async get(id: HtlcId): Promise<HtlcRecord | undefined> {
    const rows = await this.db.query<HtlcRow>('SELECT * FROM htlcs WHERE id = ?', [id]);
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async setState(id: HtlcId, state: HtlcLifecycleState): Promise<void> {
    await this.db.exec('UPDATE htlcs SET state = ?, updated_at = ? WHERE id = ?', [
      state,
      String(Date.now()),
      id,
    ]);
  }

  async listInflight(): Promise<readonly HtlcRecord[]> {
    const rows = await this.db.query<HtlcRow>("SELECT * FROM htlcs WHERE state = 'inflight'");
    return rows.map(rowToRecord);
  }

  async countInflight(): Promise<number> {
    const rows = await this.db.query<{ n: number }>(
      "SELECT COUNT(*) as n FROM htlcs WHERE state = 'inflight'",
    );
    return Number(rows[0]?.n ?? 0);
  }

  async listByChannel(channelId: ChannelId): Promise<readonly HtlcRecord[]> {
    const rows = await this.db.query<HtlcRow>('SELECT * FROM htlcs WHERE channel_id = ?', [
      channelId,
    ]);
    return rows.map(rowToRecord);
  }
}
