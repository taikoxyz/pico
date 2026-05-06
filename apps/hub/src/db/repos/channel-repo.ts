import type { ChainId, Channel, ChannelId, ChannelStatus } from '@pico/protocol';
import type { DbDriver } from '../types.js';

interface ChannelRow {
  readonly id: string;
  readonly chain_id: number;
  readonly contract: string;
  readonly user_a: string;
  readonly user_b: string;
  readonly token: string;
  readonly status: string;
  readonly opened_at: string;
  readonly dispute_window_ms: string;
}

function rowToChannel(r: ChannelRow): Channel {
  return {
    id: r.id as Channel['id'],
    chainId: r.chain_id as ChainId,
    contract: r.contract as Channel['contract'],
    userA: r.user_a as Channel['userA'],
    userB: r.user_b as Channel['userB'],
    token: r.token as Channel['token'],
    status: r.status as ChannelStatus,
    openedAt: BigInt(r.opened_at),
    disputeWindowMs: Number(r.dispute_window_ms),
  };
}

export class ChannelRepo {
  constructor(private readonly db: DbDriver) {}

  async upsert(channel: Channel): Promise<void> {
    await this.db.exec(
      `INSERT INTO channels (id, chain_id, contract, user_a, user_b, token, status, opened_at, dispute_window_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         opened_at = excluded.opened_at`,
      [
        channel.id,
        channel.chainId,
        channel.contract,
        channel.userA.toLowerCase(),
        channel.userB.toLowerCase(),
        channel.token,
        channel.status,
        channel.openedAt.toString(),
        String(channel.disputeWindowMs),
      ],
    );
  }

  async get(id: ChannelId): Promise<Channel | undefined> {
    const rows = await this.db.query<ChannelRow>('SELECT * FROM channels WHERE id = ?', [id]);
    return rows[0] ? rowToChannel(rows[0]) : undefined;
  }

  async list(): Promise<readonly Channel[]> {
    const rows = await this.db.query<ChannelRow>('SELECT * FROM channels');
    return rows.map(rowToChannel);
  }

  async setStatus(id: ChannelId, status: ChannelStatus): Promise<void> {
    await this.db.exec('UPDATE channels SET status = ? WHERE id = ?', [status, id]);
  }

  async countByStatus(): Promise<Record<ChannelStatus, number>> {
    const rows = await this.db.query<{ status: ChannelStatus; n: number }>(
      'SELECT status, COUNT(*) as n FROM channels GROUP BY status',
    );
    const out: Record<ChannelStatus, number> = {
      pending: 0,
      open: 0,
      'closing-cooperative': 0,
      'closing-unilateral': 0,
      disputed: 0,
      closed: 0,
    };
    for (const r of rows) out[r.status] = Number(r.n);
    return out;
  }
}
