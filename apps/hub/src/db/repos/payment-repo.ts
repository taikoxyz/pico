import type { Address, ChannelId, HtlcId, PaymentHash, Preimage } from '@tainnel/protocol';
import type { DbDriver } from '../types.js';

export type PaymentStatus = 'pending' | 'in_flight' | 'settled' | 'failed';

export interface PaymentRecord {
  readonly id: string;
  readonly paymentHash: PaymentHash;
  readonly incomingChannelId?: ChannelId;
  readonly outgoingChannelId?: ChannelId;
  readonly incomingHtlcId?: HtlcId;
  readonly outgoingHtlcId?: HtlcId;
  readonly recipient: Address;
  readonly amount: bigint;
  readonly fee: bigint;
  readonly status: PaymentStatus;
  readonly preimage?: Preimage;
  readonly reason?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly settledAt?: number;
  readonly failedAt?: number;
}

interface PaymentRow {
  readonly id: string;
  readonly payment_hash: string;
  readonly incoming_channel_id: string | null;
  readonly outgoing_channel_id: string | null;
  readonly incoming_htlc_id: string | null;
  readonly outgoing_htlc_id: string | null;
  readonly recipient: string;
  readonly amount: string;
  readonly fee: string;
  readonly status: PaymentStatus;
  readonly preimage: string | null;
  readonly reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly settled_at: string | null;
  readonly failed_at: string | null;
}

function rowToPayment(r: PaymentRow): PaymentRecord {
  return {
    id: r.id,
    paymentHash: r.payment_hash as PaymentHash,
    ...(r.incoming_channel_id ? { incomingChannelId: r.incoming_channel_id as ChannelId } : {}),
    ...(r.outgoing_channel_id ? { outgoingChannelId: r.outgoing_channel_id as ChannelId } : {}),
    ...(r.incoming_htlc_id ? { incomingHtlcId: r.incoming_htlc_id as HtlcId } : {}),
    ...(r.outgoing_htlc_id ? { outgoingHtlcId: r.outgoing_htlc_id as HtlcId } : {}),
    recipient: r.recipient as Address,
    amount: BigInt(r.amount),
    fee: BigInt(r.fee),
    status: r.status,
    ...(r.preimage ? { preimage: r.preimage as Preimage } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    ...(r.settled_at ? { settledAt: Number(r.settled_at) } : {}),
    ...(r.failed_at ? { failedAt: Number(r.failed_at) } : {}),
  };
}

export interface CreatePaymentInput {
  readonly id: string;
  readonly paymentHash: PaymentHash;
  readonly incomingChannelId?: ChannelId;
  readonly outgoingChannelId?: ChannelId;
  readonly incomingHtlcId?: HtlcId;
  readonly outgoingHtlcId?: HtlcId;
  readonly recipient: Address;
  readonly amount: bigint;
  readonly fee: bigint;
  readonly status: PaymentStatus;
}

export class PaymentRepo {
  constructor(private readonly db: DbDriver) {}

  async create(input: CreatePaymentInput): Promise<void> {
    const now = String(Date.now());
    await this.db.exec(
      `INSERT INTO payments (id, payment_hash, incoming_channel_id, outgoing_channel_id,
                             incoming_htlc_id, outgoing_htlc_id, recipient, amount, fee, status,
                             created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.paymentHash,
        input.incomingChannelId ?? null,
        input.outgoingChannelId ?? null,
        input.incomingHtlcId ?? null,
        input.outgoingHtlcId ?? null,
        input.recipient.toLowerCase(),
        input.amount.toString(),
        input.fee.toString(),
        input.status,
        now,
        now,
      ],
    );
  }

  async settle(id: string, preimage: Preimage): Promise<void> {
    const now = String(Date.now());
    await this.db.exec(
      `UPDATE payments SET status = 'settled', preimage = ?, settled_at = ?, updated_at = ?
       WHERE id = ?`,
      [preimage, now, now, id],
    );
  }

  async fail(id: string, reason: string): Promise<void> {
    const now = String(Date.now());
    await this.db.exec(
      `UPDATE payments SET status = 'failed', reason = ?, failed_at = ?, updated_at = ?
       WHERE id = ?`,
      [reason, now, now, id],
    );
  }

  async get(id: string): Promise<PaymentRecord | undefined> {
    const rows = await this.db.query<PaymentRow>('SELECT * FROM payments WHERE id = ?', [id]);
    return rows[0] ? rowToPayment(rows[0]) : undefined;
  }

  async listByStatus(status: PaymentStatus): Promise<readonly PaymentRecord[]> {
    const rows = await this.db.query<PaymentRow>('SELECT * FROM payments WHERE status = ?', [
      status,
    ]);
    return rows.map(rowToPayment);
  }

  async countByStatus(): Promise<Record<PaymentStatus, number>> {
    const rows = await this.db.query<{ status: PaymentStatus; n: number }>(
      'SELECT status, COUNT(*) as n FROM payments GROUP BY status',
    );
    const out: Record<PaymentStatus, number> = {
      pending: 0,
      in_flight: 0,
      settled: 0,
      failed: 0,
    };
    for (const r of rows) out[r.status] = Number(r.n);
    return out;
  }
}
