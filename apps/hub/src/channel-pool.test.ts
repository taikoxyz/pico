import type { Channel, ChannelState, Signature, SignedState } from '@tainnel/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelPool } from './channel-pool.js';
import { type TestDb, makeTestDb } from './db/repos/_test-helpers.js';
import { logger } from './logger.js';

const ZERO_SIG: Signature = {
  r: `0x${'00'.repeat(32)}`,
  s: `0x${'00'.repeat(32)}`,
  v: 27,
};

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

function signedAt(version: bigint): SignedState {
  const state: ChannelState = {
    channelId: SAMPLE.id,
    version,
    balanceA: 100n,
    balanceB: 0n,
    htlcs: [],
    finalized: false,
  };
  return { state, sigA: ZERO_SIG, sigB: ZERO_SIG };
}

describe('ChannelPool with persistence', () => {
  let h: TestDb;
  let pool: ChannelPool;

  beforeEach(async () => {
    h = await makeTestDb();
    pool = new ChannelPool({
      logger,
      channelRepo: h.repos.channels,
      stateRepo: h.repos.states,
    });
  });
  afterEach(async () => h.cleanup());

  it('persists on register and exposes the channel synchronously after', async () => {
    await pool.register(SAMPLE, signedAt(1n));
    expect(pool.get(SAMPLE.id)?.id).toBe(SAMPLE.id);
    expect(pool.latest(SAMPLE.id)?.state.version).toBe(1n);

    const stored = await h.repos.channels.get(SAMPLE.id);
    expect(stored?.id).toBe(SAMPLE.id);
    const state = await h.repos.states.latest(SAMPLE.id);
    expect(state?.state.version).toBe(1n);
  });

  it('hydrate restores state from a previous run', async () => {
    await pool.register(SAMPLE, signedAt(1n));
    await pool.recordState(SAMPLE.id, signedAt(2n));

    const reborn = new ChannelPool({
      logger,
      channelRepo: h.repos.channels,
      stateRepo: h.repos.states,
    });
    expect(reborn.get(SAMPLE.id)).toBeUndefined();
    await reborn.hydrate();
    expect(reborn.get(SAMPLE.id)?.id).toBe(SAMPLE.id);
    expect(reborn.latest(SAMPLE.id)?.state.version).toBe(2n);
  });

  it('recordState silently drops stale versions', async () => {
    await pool.register(SAMPLE, signedAt(5n));
    await pool.recordState(SAMPLE.id, signedAt(3n));
    expect(pool.latest(SAMPLE.id)?.state.version).toBe(5n);
  });

  it('setStatus persists and updates the in-memory channel', async () => {
    await pool.register(SAMPLE);
    await pool.setStatus(SAMPLE.id, 'open');
    expect(pool.get(SAMPLE.id)?.status).toBe('open');
    expect((await h.repos.channels.get(SAMPLE.id))?.status).toBe('open');
  });

  it('serializes concurrent ops on the same channel', async () => {
    await pool.register(SAMPLE);
    const order: bigint[] = [];
    await Promise.all([
      pool
        .recordState(SAMPLE.id, signedAt(1n))
        .then(() => order.push(pool.latest(SAMPLE.id)?.state.version ?? 0n)),
      pool
        .recordState(SAMPLE.id, signedAt(2n))
        .then(() => order.push(pool.latest(SAMPLE.id)?.state.version ?? 0n)),
      pool
        .recordState(SAMPLE.id, signedAt(3n))
        .then(() => order.push(pool.latest(SAMPLE.id)?.state.version ?? 0n)),
    ]);
    expect(order).toEqual([1n, 2n, 3n]);
  });
});
