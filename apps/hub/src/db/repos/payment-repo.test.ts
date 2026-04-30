import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, makeTestDb } from './_test-helpers.js';

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
