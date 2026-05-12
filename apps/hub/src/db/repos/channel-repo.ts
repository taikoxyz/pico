import type { ChainId, Channel, ChannelId, ChannelStatus } from '@inferenceroom/pico-protocol';
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
  readonly amount_a: string | null;
  readonly amount_b: string | null;
}

export interface ChannelAmounts {
  readonly amountA: bigint;
  readonly amountB: bigint;
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

  async upsert(channel: Channel, amounts?: ChannelAmounts): Promise<void> {
    // Seed amounts on initial insert (defaults preserved on conflict so a
    // later top-up via updateAmounts does not get clobbered by a re-upsert).
    await this.db.exec(
      `INSERT INTO channels (id, chain_id, contract, user_a, user_b, token, status, opened_at, dispute_window_ms, amount_a, amount_b)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        amounts?.amountA.toString() ?? '0',
        amounts?.amountB.toString() ?? '0',
      ],
    );
  }

  async get(id: ChannelId): Promise<Channel | undefined> {
    const rows = await this.db.query<ChannelRow>('SELECT * FROM channels WHERE id = ?', [id]);
    return rows[0] ? rowToChannel(rows[0]) : undefined;
  }

  /**
   * Returns the persisted on-chain `amountA` / `amountB` for the channel.
   * Used by the router's per-channel HTLC value cap (§4.3) and by topup
   * accounting after a `ToppedUp` confirms.
   */
  async getAmounts(id: ChannelId): Promise<ChannelAmounts | undefined> {
    const rows = await this.db.query<{ amount_a: string | null; amount_b: string | null }>(
      'SELECT amount_a, amount_b FROM channels WHERE id = ?',
      [id],
    );
    const r = rows[0];
    if (!r) return undefined;
    return {
      amountA: BigInt(r.amount_a ?? '0'),
      amountB: BigInt(r.amount_b ?? '0'),
    };
  }

  async list(): Promise<readonly Channel[]> {
    const rows = await this.db.query<ChannelRow>('SELECT * FROM channels');
    return rows.map(rowToChannel);
  }

  async setStatus(id: ChannelId, status: ChannelStatus): Promise<void> {
    await this.db.exec('UPDATE channels SET status = ? WHERE id = ?', [status, id]);
  }

  /**
   * Sets the on-chain deposit amounts. Called by the topup-handler once a
   * `ToppedUp` event confirms.
   */
  async updateAmounts(id: ChannelId, amountA: bigint, amountB: bigint): Promise<void> {
    await this.db.exec('UPDATE channels SET amount_a = ?, amount_b = ? WHERE id = ?', [
      amountA.toString(),
      amountB.toString(),
      id,
    ]);
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
      'resolving-htlcs': 0,
      disputed: 0,
      closed: 0,
    };
    for (const r of rows) out[r.status] = Number(r.n);
    return out;
  }
}
