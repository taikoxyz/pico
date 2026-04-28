import type { Channel, ChannelId, Hex, Htlc, HtlcId } from '@tainnel/protocol';
import { TAIKO_MAINNET_CHAIN_ID } from '@tainnel/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelPool } from './channel-pool.js';
import { SqliteDatabase, buildRepos } from './db/index.js';
import { InsufficientLiquidityError, LiquidityTracker } from './liquidity.js';
import { logger } from './logger.js';
import { PreimageRegistry } from './preimage-registry.js';
import { ChannelNotOpenError, Router, UnknownPaymentHashError } from './router.js';

const fromId = '0x0000000000000000000000000000000000000000000000000000000000001111' as ChannelId;
const toId = '0x0000000000000000000000000000000000000000000000000000000000002222' as ChannelId;
const paymentHash = `0x${'aa'.repeat(32)}` as Hex;
const preimage = `0x${'bb'.repeat(32)}` as Hex;

function makeChannel(id: ChannelId, status: Channel['status'] = 'open'): Channel {
  return {
    id,
    chainId: TAIKO_MAINNET_CHAIN_ID,
    contract: '0x4444444444444444444444444444444444444444' as Channel['contract'],
    userA: '0x1111111111111111111111111111111111111111' as Channel['userA'],
    userB: '0x2222222222222222222222222222222222222222' as Channel['userB'],
    token: '0x3333333333333333333333333333333333333333' as Channel['token'],
    status,
    openedAt: 100n,
    disputeWindowMs: 24 * 60 * 60 * 1000,
  };
}

const htlc: Htlc = {
  id: `0x${'cc'.repeat(32)}` as HtlcId,
  direction: 'AtoB',
  amount: 50n,
  paymentHash,
  expiryMs: 999_999_999n,
};

describe('Router', () => {
  let db: SqliteDatabase;
  let pool: ChannelPool;
  let liquidity: LiquidityTracker;
  let preimages: PreimageRegistry;
  let router: Router;

  beforeEach(async () => {
    db = new SqliteDatabase(':memory:');
    await db.ready();
    const repos = buildRepos(db);
    pool = new ChannelPool({ logger, channelRepo: repos.channels, stateRepo: repos.states });
    liquidity = new LiquidityTracker();
    preimages = new PreimageRegistry();
    pool.register(makeChannel(fromId));
    pool.register(makeChannel(toId));
    liquidity.set(toId, { inbound: 0n, outbound: 100n });
    router = new Router({ channelPool: pool, preimages, liquidity });
  });

  afterEach(async () => {
    await db.close();
  });

  it('happy path returns the preimage', async () => {
    preimages.register(paymentHash, preimage);
    const result = await router.route({ fromChannel: fromId, toChannel: toId, htlc });
    expect(result.preimage).toBe(preimage);
  });

  it('throws UnknownPaymentHashError when no preimage', async () => {
    await expect(
      router.route({ fromChannel: fromId, toChannel: toId, htlc }),
    ).rejects.toBeInstanceOf(UnknownPaymentHashError);
  });

  it('throws InsufficientLiquidityError when amount > capacity', async () => {
    preimages.register(paymentHash, preimage);
    const fat = { ...htlc, amount: 999_999n };
    await expect(
      router.route({ fromChannel: fromId, toChannel: toId, htlc: fat }),
    ).rejects.toBeInstanceOf(InsufficientLiquidityError);
  });

  it('throws ChannelNotOpenError when channels are not open', async () => {
    pool.setStatus(toId, 'closed');
    await expect(
      router.route({ fromChannel: fromId, toChannel: toId, htlc }),
    ).rejects.toBeInstanceOf(ChannelNotOpenError);
  });
});
