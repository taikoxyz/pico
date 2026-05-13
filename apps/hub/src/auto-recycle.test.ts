import type {
  Address,
  ChainId,
  Channel,
  ChannelId,
  Hex,
  ProposeTopUpMessage,
} from '@inferenceroom/pico-protocol';
import type {
  ChainAdapter,
  CloseCooperativeOnChainArgs,
  CloseOnChainResult,
  CloseUnilateralFromOpenOnChainArgs,
  CloseUnilateralOnChainArgs,
  CloseUnilateralOnChainResult,
  FinalizedResult,
  OpenChannelOnChainArgs,
  OpenChannelOnChainResult,
  TopUpOnChainArgs,
  TopUpOnChainResult,
} from '@inferenceroom/pico-sdk';
import { Registry } from 'prom-client';
import type { Hash } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AutoRecycle } from './auto-recycle.js';
import { ChannelPool } from './channel-pool.js';
import { type TestDb, makeTestDb } from './db/repos/_test-helpers.js';
import { LiquidityTracker } from './liquidity.js';
import { logger } from './logger.js';
import { buildMetrics } from './metrics.js';
import { KeyedMutex } from './mutex.js';
import { TopUpHandler } from './topup-handler.js';
import { DEFAULT_TOPUP_POLICY } from './topup-policy.js';

const CHAIN_ID: ChainId = 31337;
const VC: Address = '0x0000000000000000000000000000000000000001' as Address;
const TOKEN: Address = '0x0000000000000000000000000000000000000099' as Address;
const HUB_KEY = '0x00000000000000000000000000000000000000000000000000000000000000bb' as const;
const CAROL_KEY = '0x00000000000000000000000000000000000000000000000000000000c0c0c001' as const;

class StubChain implements ChainAdapter {
  topUpCalls: TopUpOnChainArgs[] = [];

  async openChannel(_a: OpenChannelOnChainArgs): Promise<OpenChannelOnChainResult> {
    throw new Error('not used');
  }
  async closeCooperative(_a: CloseCooperativeOnChainArgs): Promise<CloseOnChainResult> {
    throw new Error('not used');
  }
  async closeUnilateral(_a: CloseUnilateralOnChainArgs): Promise<CloseUnilateralOnChainResult> {
    throw new Error('not used');
  }
  async closeUnilateralFromOpen(
    _a: CloseUnilateralFromOpenOnChainArgs,
  ): Promise<CloseUnilateralOnChainResult> {
    throw new Error('not used');
  }
  async topUp(args: TopUpOnChainArgs): Promise<TopUpOnChainResult> {
    this.topUpCalls.push(args);
    return {
      txHash: '0x3333333333333333333333333333333333333333333333333333333333333333' as Hash,
      newVersion: args.next.state.version,
      amount: args.amount,
    };
  }
  async finalize(_id: ChannelId): Promise<FinalizedResult> {
    throw new Error('not used');
  }
  async waitForFinalized(): Promise<FinalizedResult> {
    return new Promise(() => {});
  }
}

function chId(short: string): Hex {
  return `0x${short.padEnd(64, '0')}` as Hex;
}

function makeChannel(idShort: string, userA: Address, userB: Address): Channel {
  return {
    id: chId(idShort) as ChannelId,
    chainId: CHAIN_ID,
    contract: VC,
    userA,
    userB,
    token: TOKEN,
    status: 'open',
    openedAt: BigInt(Date.now()),
    disputeWindowMs: 24 * 60 * 60 * 1000,
  };
}

describe('AutoRecycle.onClose', () => {
  let h: TestDb;
  let pool: ChannelPool;
  let liquidity: LiquidityTracker;
  let chain: StubChain;
  let hotWalletMutex: KeyedMutex<string>;
  let handler: TopUpHandler;
  let autoRecycle: AutoRecycle;
  let proposed: Array<{ to: Address; msg: ProposeTopUpMessage }>;
  let hubBalance: bigint;
  const hubAccount = privateKeyToAccount(HUB_KEY);
  const carolAccount = privateKeyToAccount(CAROL_KEY);

  beforeEach(async () => {
    h = await makeTestDb();
    pool = new ChannelPool({
      logger,
      channelRepo: h.repos.channels,
      stateRepo: h.repos.states,
    });
    liquidity = new LiquidityTracker();
    chain = new StubChain();
    hotWalletMutex = new KeyedMutex<string>();
    proposed = [];
    hubBalance = 0n;
    handler = new TopUpHandler({
      channelPool: pool,
      liquidity,
      repos: h.repos,
      metrics: buildMetrics(new Registry()),
      logger,
      hubAccount,
      chainId: CHAIN_ID,
      verifyingContract: VC,
      chain,
      token: TOKEN,
      policyConfig: DEFAULT_TOPUP_POLICY,
      hotWalletMutex,
      readHotWalletBalance: async () => hubBalance,
      pushProposeTopUp: (to, msg) => {
        proposed.push({ to, msg });
        return true;
      },
    });
    autoRecycle = new AutoRecycle({
      logger,
      repos: h.repos,
      channelPool: pool,
      topupHandler: handler,
      hotWalletMutex,
    });
  });
  afterEach(async () => h.cleanup());

  it('proposes the queued offer when liquidity arrives (Scenario 13)', async () => {
    // Set up: Carol's channel opens with hub, but hub has 0 USDC headroom →
    // queued. Then Bob's close pays hub 4 USDC → auto-recycle proposes 4.
    hubBalance = 0n;
    const carolChannel = makeChannel('cc01', carolAccount.address, hubAccount.address);
    await pool.register(carolChannel, undefined, { amountA: 10_000_000n, amountB: 0n });
    await handler.evaluateNewChannel(carolChannel);

    const queued = await h.repos.topupOffers.listQueued();
    expect(queued).toHaveLength(1);
    expect(proposed).toHaveLength(0);

    // Now hub recovers 4 USDC from Bob's close. Update the simulated wallet
    // balance and trigger auto-recycle.
    hubBalance = 4_000_000n;
    await autoRecycle.onClose(chId('bb01') as ChannelId, 4_000_000n);

    // A real propose should have been pushed to Carol with amount=4 USDC.
    expect(proposed).toHaveLength(1);
    expect(proposed[0]?.to.toLowerCase()).toBe(carolAccount.address.toLowerCase());
    expect(proposed[0]?.msg.amount).toBe(4_000_000n);

    // Original queued row was retired.
    const stillQueued = await h.repos.topupOffers.listQueued();
    expect(stillQueued).toHaveLength(0);
  });

  it('is a no-op when there are no queued offers', async () => {
    await autoRecycle.onClose(chId('bb02') as ChannelId, 5_000_000n);
    expect(proposed).toHaveLength(0);
  });

  it('does nothing when hubReceived <= 0', async () => {
    // Insert a queued row to make sure it's NOT picked up.
    hubBalance = 0n;
    const carolChannel = makeChannel('cc02', carolAccount.address, hubAccount.address);
    await pool.register(carolChannel, undefined, { amountA: 10_000_000n, amountB: 0n });
    await handler.evaluateNewChannel(carolChannel);
    await autoRecycle.onClose(chId('bb03') as ChannelId, 0n);
    expect(proposed).toHaveLength(0);
    const queued = await h.repos.topupOffers.listQueued();
    expect(queued).toHaveLength(1);
  });
});
