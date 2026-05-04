import type { Channel } from '@pico/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, makeTestDb } from './_test-helpers.js';

const SAMPLE: Channel = {
  id: '0xaa',
  chainId: 31337,
  contract: '0x0000000000000000000000000000000000000001',
  userA: '0x00000000000000000000000000000000000000A1',
  userB: '0x00000000000000000000000000000000000000B0',
  token: '0x0000000000000000000000000000000000000099',
  status: 'pending',
  openedAt: 0n,
  disputeWindowMs: 86_400_000,
};

describe('ChannelRepo', () => {
  let h: TestDb;
  beforeEach(async () => {
    h = await makeTestDb();
  });
  afterEach(async () => h.cleanup());

  it('upserts, reads, lists, and updates status', async () => {
    await h.repos.channels.upsert(SAMPLE);
    const got = await h.repos.channels.get(SAMPLE.id);
    expect(got?.userA).toBe(SAMPLE.userA.toLowerCase());
    expect(got?.status).toBe('pending');

    await h.repos.channels.setStatus(SAMPLE.id, 'open');
    const list = await h.repos.channels.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.status).toBe('open');
  });

  it('upsert updates status on conflict (idempotent)', async () => {
    await h.repos.channels.upsert(SAMPLE);
    await h.repos.channels.upsert({ ...SAMPLE, status: 'open' });
    expect((await h.repos.channels.get(SAMPLE.id))?.status).toBe('open');
  });

  it('returns undefined for unknown channel', async () => {
    expect(await h.repos.channels.get('0xff')).toBeUndefined();
  });
});
