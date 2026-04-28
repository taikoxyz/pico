import type { Channel, ChannelId, Hex, SignedState } from '@tainnel/protocol';
import { TAIKO_MAINNET_CHAIN_ID } from '@tainnel/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelPool, StaleStateError } from './channel-pool.js';
import { SqliteDatabase, buildRepos } from './db/index.js';
import { logger } from './logger.js';

const channelId = '0x0000000000000000000000000000000000000000000000000000000000000abc' as ChannelId;

function makeChannel(): Channel {
  return {
    id: channelId,
    chainId: TAIKO_MAINNET_CHAIN_ID,
    contract: '0x4444444444444444444444444444444444444444' as Channel['contract'],
    userA: '0x1111111111111111111111111111111111111111' as Channel['userA'],
    userB: '0x2222222222222222222222222222222222222222' as Channel['userB'],
    token: '0x3333333333333333333333333333333333333333' as Channel['token'],
    status: 'open',
    openedAt: 100n,
    disputeWindowMs: 24 * 60 * 60 * 1000,
  };
}

function makeSigned(version: bigint): SignedState {
  return {
    state: { channelId, version, balanceA: 100n, balanceB: 200n, htlcs: [], finalized: false },
    sigA: { r: '0x' as Hex, s: '0x' as Hex, v: 27 },
    sigB: { r: '0x' as Hex, s: '0x' as Hex, v: 27 },
  };
}

describe('ChannelPool', () => {
  let db: SqliteDatabase;
  let repos: ReturnType<typeof buildRepos>;
  let pool: ChannelPool;

  beforeEach(async () => {
    db = new SqliteDatabase(':memory:');
    await db.ready();
    repos = buildRepos(db);
    pool = new ChannelPool({ logger, channelRepo: repos.channels, stateRepo: repos.states });
  });

  afterEach(async () => {
    await db.close();
  });

  it('register persists to DB', () => {
    pool.register(makeChannel());
    expect(repos.channels.get(channelId)).toBeDefined();
    expect(pool.size()).toBe(1);
  });

  it('recordState rejects stale versions', () => {
    pool.register(makeChannel());
    pool.recordState(channelId, makeSigned(5n));
    expect(() => pool.recordState(channelId, makeSigned(5n))).toThrow(StaleStateError);
    expect(() => pool.recordState(channelId, makeSigned(4n))).toThrow(StaleStateError);
    pool.recordState(channelId, makeSigned(6n));
    expect(pool.latest(channelId)?.state.version).toBe(6n);
  });

  it('hydrate rebuilds from DB', () => {
    pool.register(makeChannel());
    pool.recordState(channelId, makeSigned(7n));
    const fresh = new ChannelPool({
      logger,
      channelRepo: repos.channels,
      stateRepo: repos.states,
    });
    fresh.hydrate();
    expect(fresh.get(channelId)).toBeDefined();
    expect(fresh.latest(channelId)?.state.version).toBe(7n);
  });

  it('withLock serializes concurrent operations on the same channel', async () => {
    const order: number[] = [];
    const a = pool.withLock(channelId, async () => {
      order.push(1);
      await new Promise((res) => setTimeout(res, 30));
      order.push(2);
    });
    const b = pool.withLock(channelId, async () => {
      order.push(3);
    });
    await Promise.all([a, b]);
    expect(order).toEqual([1, 2, 3]);
  });
});
