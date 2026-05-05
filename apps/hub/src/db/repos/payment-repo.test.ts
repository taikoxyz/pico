import type { Address, ChannelId, PaymentHash } from '@pico/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, makeTestDb } from './_test-helpers.js';

const RECIPIENT = '0x00000000000000000000000000000000000000B0' as Address;

interface PaymentSeed {
  readonly id: string;
  readonly incoming?: ChannelId;
  readonly outgoing?: ChannelId;
  readonly status?: 'in_flight' | 'settled' | 'failed';
  readonly createdAt?: number;
}

async function seed(h: TestDb, p: PaymentSeed): Promise<void> {
  await h.repos.payments.create({
    id: p.id,
    paymentHash: '0xph' as PaymentHash,
    ...(p.incoming ? { incomingChannelId: p.incoming } : {}),
    ...(p.outgoing ? { outgoingChannelId: p.outgoing } : {}),
    recipient: RECIPIENT,
    amount: 1n,
    fee: 0n,
    status: p.status ?? 'settled',
  });
  // create() always stamps Date.now(); rewrite when the test needs a fixed
  // ordering. Using id DESC as the secondary key keeps ties deterministic.
  if (p.createdAt !== undefined) {
    await h.driver.exec('UPDATE payments SET created_at = ? WHERE id = ?', [
      String(p.createdAt),
      p.id,
    ]);
  }
}

async function countPayments(h: TestDb): Promise<number> {
  const rows = await h.driver.query<{ n: number }>('SELECT COUNT(*) as n FROM payments');
  return Number(rows[0]?.n ?? 0);
}

async function idsForChannel(h: TestDb, channelId: string): Promise<string[]> {
  const rows = await h.driver.query<{ id: string }>(
    `SELECT id FROM payments
     WHERE incoming_channel_id = ? OR outgoing_channel_id = ?
     ORDER BY created_at DESC, id DESC`,
    [channelId, channelId],
  );
  return rows.map((r) => r.id);
}

describe('PaymentRepo', () => {
  let h: TestDb;
  beforeEach(async () => {
    h = await makeTestDb();
  });
  afterEach(async () => h.cleanup());

  it('creates, settles, and reads a payment', async () => {
    await h.repos.payments.create({
      id: 'p1',
      paymentHash: '0xph',
      recipient: '0x00000000000000000000000000000000000000B0',
      amount: 1000n,
      fee: 1n,
      status: 'in_flight',
    });
    await h.repos.payments.settle('p1', '0xpre');
    const got = await h.repos.payments.get('p1');
    expect(got?.status).toBe('settled');
    expect(got?.preimage).toBe('0xpre');
    expect(got?.amount).toBe(1000n);
    expect(got?.fee).toBe(1n);
    expect(got?.recipient).toBe('0x00000000000000000000000000000000000000b0');
  });

  it('records a failure and reason', async () => {
    await h.repos.payments.create({
      id: 'p2',
      paymentHash: '0xph2',
      recipient: '0x00000000000000000000000000000000000000B0',
      amount: 50n,
      fee: 0n,
      status: 'in_flight',
    });
    await h.repos.payments.fail('p2', 'expiry too tight');
    const got = await h.repos.payments.get('p2');
    expect(got?.status).toBe('failed');
    expect(got?.reason).toBe('expiry too tight');
  });

  describe('prunePerChannel', () => {
    const A = '0xchA' as ChannelId;
    const B = '0xchB' as ChannelId;
    const C = '0xchC' as ChannelId;

    it('caps a single channel pair to the latest N rows', async () => {
      for (let i = 0; i < 150; i++) {
        await seed(h, { id: `p${i}`, incoming: A, outgoing: B, createdAt: 1_000 + i });
      }
      const removed = await h.repos.payments.prunePerChannel(100);
      expect(removed).toBe(50);
      expect(await countPayments(h)).toBe(100);
      const survivors = await idsForChannel(h, A);
      // The 100 most recent are p149 .. p50.
      expect(survivors[0]).toBe('p149');
      expect(survivors[99]).toBe('p50');
      expect(survivors).not.toContain('p49');
    });

    it('keeps a row when at least one of its channels still ranks it top-N', async () => {
      // 100 newest A->B, then 100 newest A->C, then 1 cross-direction C->A.
      // A appears in 201 rows (as incoming for 200, as outgoing for 1).
      // The cross-direction row is rank 1 in C->A's outgoing partition for A,
      // so it should survive even if it falls outside A's top-100 incoming view.
      let t = 0;
      for (let i = 0; i < 100; i++) {
        await seed(h, { id: `ab${i}`, incoming: A, outgoing: B, createdAt: 1_000 + t++ });
      }
      for (let i = 0; i < 100; i++) {
        await seed(h, { id: `ac${i}`, incoming: A, outgoing: C, createdAt: 1_000 + t++ });
      }
      // The cross-direction row is OLDER than every other A row, so it is rank
      // 201 in A's combined view but rank 1 in its own outgoing (A) partition.
      await seed(h, { id: 'caX', incoming: C, outgoing: A, createdAt: 500 });

      await h.repos.payments.prunePerChannel(100);
      const ids = new Set(
        (await h.driver.query<{ id: string }>('SELECT id FROM payments')).map((r) => r.id),
      );
      expect(ids.has('caX')).toBe(true);
      // Each channel's view shows >= 100 rows it participated in.
      expect((await idsForChannel(h, A)).length).toBeGreaterThanOrEqual(100);
      expect((await idsForChannel(h, B)).length).toBe(100);
      expect((await idsForChannel(h, C)).length).toBeGreaterThanOrEqual(100);
      // Storage stays bounded: each channel anchors at most 100 unique rows.
      const totalChannels = 3;
      expect(await countPayments(h)).toBeLessThanOrEqual(100 * totalChannels);
    });

    it('never deletes in-flight or pending rows', async () => {
      for (let i = 0; i < 200; i++) {
        await seed(h, {
          id: `p${i}`,
          incoming: A,
          outgoing: B,
          status: 'in_flight',
          createdAt: 1_000 + i,
        });
      }
      const removed = await h.repos.payments.prunePerChannel(100);
      expect(removed).toBe(0);
      expect(await countPayments(h)).toBe(200);
    });

    it('keep <= 0 is a no-op', async () => {
      await seed(h, { id: 'p1', incoming: A, outgoing: B });
      await seed(h, { id: 'p2', incoming: A, outgoing: B });
      const removed = await h.repos.payments.prunePerChannel(0);
      expect(removed).toBe(0);
      expect(await countPayments(h)).toBe(2);
    });

    it('non-finite keep is a no-op', async () => {
      await seed(h, { id: 'p1', incoming: A, outgoing: B });
      await seed(h, { id: 'p2', incoming: A, outgoing: B });
      const removed = await h.repos.payments.prunePerChannel(Number.NaN);
      expect(removed).toBe(0);
      expect(await countPayments(h)).toBe(2);
    });
  });

  it('counts payments by status', async () => {
    await h.repos.payments.create({
      id: 'p3',
      paymentHash: '0x',
      recipient: '0x00000000000000000000000000000000000000B0',
      amount: 1n,
      fee: 0n,
      status: 'settled',
    });
    await h.repos.payments.create({
      id: 'p4',
      paymentHash: '0x',
      recipient: '0x00000000000000000000000000000000000000B0',
      amount: 1n,
      fee: 0n,
      status: 'in_flight',
    });
    const counts = await h.repos.payments.countByStatus();
    expect(counts.settled).toBe(1);
    expect(counts.in_flight).toBe(1);
    expect(counts.failed).toBe(0);
  });
});
