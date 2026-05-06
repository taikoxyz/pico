import type { DbDriver } from '../types.js';

// Lifetime hub counters. Values persisted as decimal strings to avoid JS Number
// precision loss for USDC sums; addBigint uses a single atomic upsert so two
// concurrent settle handlers cannot lose updates via read-modify-write.
export type StatKey = 'payments_settled' | 'payments_failed' | 'usdc_settled' | 'fees_collected';

export const STAT_KEYS: readonly StatKey[] = [
  'payments_settled',
  'payments_failed',
  'usdc_settled',
  'fees_collected',
];

export class StatsRepo {
  constructor(private readonly db: DbDriver) {}

  async addBigint(key: StatKey, delta: bigint): Promise<void> {
    if (delta === 0n) return;
    await this.db.exec(
      `INSERT INTO hub_stats (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = CAST(
         CAST(hub_stats.value AS BIGINT) + CAST(excluded.value AS BIGINT) AS TEXT
       )`,
      [key, delta.toString()],
    );
  }

  async getBigint(key: StatKey): Promise<bigint> {
    const rows = await this.db.query<{ value: string }>(
      'SELECT value FROM hub_stats WHERE key = ?',
      [key],
    );
    const raw = rows[0]?.value;
    return raw === undefined ? 0n : BigInt(raw);
  }

  async getAll(): Promise<Record<StatKey, bigint>> {
    const rows = await this.db.query<{ key: StatKey; value: string }>(
      'SELECT key, value FROM hub_stats',
    );
    const out: Record<StatKey, bigint> = {
      payments_settled: 0n,
      payments_failed: 0n,
      usdc_settled: 0n,
      fees_collected: 0n,
    };
    for (const r of rows) {
      if (r.key in out) out[r.key] = BigInt(r.value);
    }
    return out;
  }
}
