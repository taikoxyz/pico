import type { ChannelId, Hex } from '@tainnel/protocol';
import type { DbDriver } from '../types.js';

export type DisputeResolution = 'pending' | 'won' | 'lost';

export interface DisputeRecord {
  readonly channelId: ChannelId;
  readonly observedVersion: bigint;
  readonly observedAt: number;
  readonly respondedAt?: number;
  readonly responseTxHash?: Hex;
  readonly resolution: DisputeResolution;
}

interface DisputeRow {
  readonly channel_id: string;
  readonly observed_version: string;
  readonly observed_at: string;
  readonly responded_at: string | null;
  readonly response_tx_hash: string | null;
  readonly resolution: DisputeResolution | null;
}

function rowToDispute(r: DisputeRow): DisputeRecord {
  return {
    channelId: r.channel_id as ChannelId,
    observedVersion: BigInt(r.observed_version),
    observedAt: Number(r.observed_at),
    ...(r.responded_at ? { respondedAt: Number(r.responded_at) } : {}),
    ...(r.response_tx_hash ? { responseTxHash: r.response_tx_hash as Hex } : {}),
    resolution: r.resolution ?? 'pending',
  };
}

export class DisputeRepo {
  constructor(private readonly db: DbDriver) {}

  async record(channelId: ChannelId, observedVersion: bigint, observedAt: number): Promise<void> {
    await this.db.exec(
      `INSERT INTO disputes (channel_id, observed_version, observed_at, resolution)
       VALUES (?, ?, ?, 'pending')
       ON CONFLICT(channel_id, observed_version) DO NOTHING`,
      [channelId, observedVersion.toString(), String(observedAt)],
    );
  }

  async markResponded(
    channelId: ChannelId,
    observedVersion: bigint,
    txHash: Hex,
    respondedAt: number,
  ): Promise<void> {
    await this.db.exec(
      `UPDATE disputes
       SET responded_at = ?, response_tx_hash = ?
       WHERE channel_id = ? AND observed_version = ?`,
      [String(respondedAt), txHash, channelId, observedVersion.toString()],
    );
  }

  async markResolution(
    channelId: ChannelId,
    observedVersion: bigint,
    resolution: DisputeResolution,
  ): Promise<void> {
    await this.db.exec(
      'UPDATE disputes SET resolution = ? WHERE channel_id = ? AND observed_version = ?',
      [resolution, channelId, observedVersion.toString()],
    );
  }

  async list(): Promise<readonly DisputeRecord[]> {
    const rows = await this.db.query<DisputeRow>('SELECT * FROM disputes ORDER BY observed_at');
    return rows.map(rowToDispute);
  }

  async listUnresponded(): Promise<readonly DisputeRecord[]> {
    const rows = await this.db.query<DisputeRow>(
      `SELECT * FROM disputes
       WHERE responded_at IS NULL AND (resolution IS NULL OR resolution = 'pending')
       ORDER BY observed_at`,
    );
    return rows.map(rowToDispute);
  }

  async countByResolution(): Promise<Record<DisputeResolution, number>> {
    const rows = await this.db.query<{ resolution: DisputeResolution | null; n: number }>(
      'SELECT resolution, COUNT(*) as n FROM disputes GROUP BY resolution',
    );
    const out: Record<DisputeResolution, number> = { pending: 0, won: 0, lost: 0 };
    for (const r of rows) {
      const key = r.resolution ?? 'pending';
      out[key] = Number(r.n);
    }
    return out;
  }
}
