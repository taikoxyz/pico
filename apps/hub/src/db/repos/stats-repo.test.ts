import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, makeTestDb } from './_test-helpers.js';

describe('StatsRepo', () => {
  let h: TestDb;
  beforeEach(async () => {
    h = await makeTestDb();
  });
  afterEach(async () => h.cleanup());

  it('returns zero for unset keys', async () => {
    expect(await h.repos.stats.getBigint('payments_settled')).toBe(0n);
    expect(await h.repos.stats.getBigint('usdc_settled')).toBe(0n);
  });

  it('addBigint accumulates across calls', async () => {
    await h.repos.stats.addBigint('payments_settled', 1n);
    await h.repos.stats.addBigint('payments_settled', 1n);
    await h.repos.stats.addBigint('payments_settled', 5n);
    expect(await h.repos.stats.getBigint('payments_settled')).toBe(7n);
  });

  it('addBigint(0n) is a no-op', async () => {
    await h.repos.stats.addBigint('usdc_settled', 0n);
    expect(await h.repos.stats.getBigint('usdc_settled')).toBe(0n);
  });

  it('survives bigint values that overflow JS Number', async () => {
    const big = 9_999_999_999_999_999n; // > Number.MAX_SAFE_INTEGER
    await h.repos.stats.addBigint('usdc_settled', big);
    await h.repos.stats.addBigint('usdc_settled', 1n);
    expect(await h.repos.stats.getBigint('usdc_settled')).toBe(big + 1n);
  });

  it('keys are independent', async () => {
    await h.repos.stats.addBigint('payments_settled', 3n);
    await h.repos.stats.addBigint('payments_failed', 2n);
    await h.repos.stats.addBigint('usdc_settled', 1_000_000n);
    await h.repos.stats.addBigint('fees_collected', 25n);
    const all = await h.repos.stats.getAll();
    expect(all).toEqual({
      payments_settled: 3n,
      payments_failed: 2n,
      usdc_settled: 1_000_000n,
      fees_collected: 25n,
    });
  });

  it('concurrent increments do not lose updates', async () => {
    const N = 50;
    await Promise.all(
      Array.from({ length: N }, () => h.repos.stats.addBigint('payments_settled', 1n)),
    );
    expect(await h.repos.stats.getBigint('payments_settled')).toBe(BigInt(N));
  });
});
