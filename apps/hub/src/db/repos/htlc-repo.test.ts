import type { Htlc } from '@inferenceroom/pico-protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, makeTestDb } from './_test-helpers.js';

const HTLC_BASE: Htlc = {
  id: '0x01',
  direction: 'AtoB',
  amount: 100n,
  paymentHash: '0xph',
  expiryMs: 1_000_000n,
};

describe('HtlcRepo', () => {
  let h: TestDb;
  beforeEach(async () => {
    h = await makeTestDb();
  });
  afterEach(async () => h.cleanup());

  it('round-trips an HTLC and updates state', async () => {
    await h.repos.htlcs.save({ htlc: HTLC_BASE, channelId: '0xaa', state: 'inflight' });
    const got = await h.repos.htlcs.get('0x01');
    expect(got?.htlc.amount).toBe(100n);
    expect(got?.state).toBe('inflight');
    await h.repos.htlcs.setState('0x01', 'settled');
    expect((await h.repos.htlcs.get('0x01'))?.state).toBe('settled');
  });

  it('listInflight returns only in-flight HTLCs', async () => {
    await h.repos.htlcs.save({ htlc: HTLC_BASE, channelId: '0xaa', state: 'inflight' });
    await h.repos.htlcs.save({
      htlc: { ...HTLC_BASE, id: '0x02' },
      channelId: '0xaa',
      state: 'settled',
    });
    const inflight = await h.repos.htlcs.listInflight();
    expect(inflight.map((h) => h.htlc.id)).toEqual(['0x01']);
  });

  it('countInflight returns the number of in-flight HTLCs', async () => {
    expect(await h.repos.htlcs.countInflight()).toBe(0);
    await h.repos.htlcs.save({ htlc: HTLC_BASE, channelId: '0xaa', state: 'inflight' });
    await h.repos.htlcs.save({
      htlc: { ...HTLC_BASE, id: '0x02' },
      channelId: '0xaa',
      state: 'inflight',
    });
    await h.repos.htlcs.save({
      htlc: { ...HTLC_BASE, id: '0x03' },
      channelId: '0xaa',
      state: 'settled',
    });
    expect(await h.repos.htlcs.countInflight()).toBe(2);
  });
});
