import type {
  Address,
  ChainId,
  Channel,
  ChannelId,
  Hex,
  Htlc,
  Signature,
  SignedState,
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
import { AutoCloseSweeper, type OnChainCloseInfo } from './auto-close.js';
import { ChannelPool } from './channel-pool.js';
import { type TestDb, makeTestDb } from './db/repos/_test-helpers.js';
import { logger } from './logger.js';
import { type HubMetrics, buildMetrics } from './metrics.js';
import { KeyedMutex } from './mutex.js';

const CHAIN_ID: ChainId = 31337;
const VC: Address = '0x0000000000000000000000000000000000000001' as Address;
const TOKEN: Address = '0x0000000000000000000000000000000000000099' as Address;
const HUB_KEY = '0x00000000000000000000000000000000000000000000000000000000000000bb' as const;
const NOW = 2_000_000_000_000;
const HOUR = 60 * 60 * 1000;
const AFTER_MS = 24 * HOUR;
const FAKE_SIG: Signature = {
  r: `0x${'11'.repeat(32)}` as Hex,
  s: `0x${'22'.repeat(32)}` as Hex,
  v: 27,
};
const TX: Hash = `0x${'ab'.repeat(32)}` as Hash;

const hub = privateKeyToAccount(HUB_KEY).address;
const ALICE: Address = '0x00000000000000000000000000000000000000a1' as Address;
const BOB: Address = '0x00000000000000000000000000000000000000b2' as Address;

class StubChain implements ChainAdapter {
  closeUnilateralCalls: CloseUnilateralOnChainArgs[] = [];
  closeUnilateralFromOpenCalls: CloseUnilateralFromOpenOnChainArgs[] = [];
  finalizeCalls: ChannelId[] = [];

  async openChannel(_a: OpenChannelOnChainArgs): Promise<OpenChannelOnChainResult> {
    throw new Error('not used');
  }
  async closeCooperative(_a: CloseCooperativeOnChainArgs): Promise<CloseOnChainResult> {
    throw new Error('not used');
  }
  async closeUnilateral(args: CloseUnilateralOnChainArgs): Promise<CloseUnilateralOnChainResult> {
    this.closeUnilateralCalls.push(args);
    return {
      txHash: TX,
      disputeDeadlineMs: BigInt(NOW + AFTER_MS),
      postedVersion: args.state.state.version,
      blockNumber: 1n,
    };
  }
  async closeUnilateralFromOpen(
    args: CloseUnilateralFromOpenOnChainArgs,
  ): Promise<CloseUnilateralOnChainResult> {
    this.closeUnilateralFromOpenCalls.push(args);
    return {
      txHash: TX,
      disputeDeadlineMs: BigInt(NOW + AFTER_MS),
      postedVersion: 0n,
      blockNumber: 1n,
    };
  }
  async topUp(_a: TopUpOnChainArgs): Promise<TopUpOnChainResult> {
    throw new Error('not used');
  }
  async finalize(id: ChannelId): Promise<FinalizedResult> {
    this.finalizeCalls.push(id);
    return { paidA: 0n, paidB: 0n, txHash: TX };
  }
  async claimHtlc(_a: { channelId: ChannelId }): Promise<{ txHash: Hex }> {
    return { txHash: TX };
  }
  async refundHtlc(_a: { channelId: ChannelId }): Promise<{ txHash: Hex }> {
    return { txHash: TX };
  }
  async waitForFinalized(): Promise<FinalizedResult> {
    return new Promise(() => {});
  }
}

function chId(short: string): ChannelId {
  return `0x${short.padEnd(64, '0')}` as ChannelId;
}

function makeChannel(
  idShort: string,
  userA: Address,
  userB: Address,
  status: Channel['status'] = 'open',
): Channel {
  return {
    id: chId(idShort),
    chainId: CHAIN_ID,
    contract: VC,
    userA,
    userB,
    token: TOKEN,
    status,
    openedAt: BigInt(NOW),
    disputeWindowMs: AFTER_MS,
  };
}

function signedState(channelId: ChannelId, version: bigint, htlcs: Htlc[] = []): SignedState {
  let locked = 0n;
  for (const h of htlcs) locked += h.amount;
  return {
    state: {
      channelId,
      version,
      balanceA: 100n,
      balanceB: 0n,
      htlcs,
      htlcsCount: htlcs.length,
      htlcsTotalLocked: locked,
      finalized: false,
    },
    sigA: FAKE_SIG,
    sigB: FAKE_SIG,
  };
}

describe('AutoCloseSweeper', () => {
  let h: TestDb;
  let pool: ChannelPool;
  let chain: StubChain;
  let metrics: HubMetrics;
  let onchain: Map<ChannelId, OnChainCloseInfo>;
  let onChainReadError: Error | undefined;
  let sweeper: AutoCloseSweeper;

  beforeEach(async () => {
    h = await makeTestDb();
    pool = new ChannelPool({ logger, channelRepo: h.repos.channels, stateRepo: h.repos.states });
    chain = new StubChain();
    metrics = buildMetrics(new Registry());
    onchain = new Map();
    onChainReadError = undefined;
    sweeper = new AutoCloseSweeper({
      logger,
      channelPool: pool,
      channelRepo: h.repos.channels,
      chain,
      hubAddress: hub,
      hotWalletMutex: new KeyedMutex<string>(),
      metrics,
      afterMs: AFTER_MS,
      intervalMs: 999_999,
      readOnChainClose: async (id) => {
        if (onChainReadError) throw onChainReadError;
        return onchain.get(id) ?? { disputeDeadlineMs: 0, status: 0, htlcsCount: 0 };
      },
      now: () => NOW,
    });
  });
  afterEach(async () => h.cleanup());

  async function setRecordedAt(channelId: ChannelId, ms: number): Promise<void> {
    await h.driver.exec('UPDATE signed_states SET recorded_at = ? WHERE channel_id = ?', [
      String(ms),
      channelId,
    ]);
  }

  it('unilaterally closes an idle channel with a co-signed state', async () => {
    const ch = makeChannel('aa', ALICE, hub);
    await pool.register(ch, signedState(ch.id, 1n), { amountA: 100n, amountB: 0n });
    await setRecordedAt(ch.id, NOW - 25 * HOUR);

    await sweeper.sweepOnce();

    expect(chain.closeUnilateralCalls).toHaveLength(1);
    expect(chain.closeUnilateralCalls[0]?.channelId).toBe(ch.id);
    expect(chain.closeUnilateralCalls[0]?.mySide).toBe('B'); // hub is userB
    expect(chain.closeUnilateralFromOpenCalls).toHaveLength(0);
    expect(pool.get(ch.id)?.status).toBe('closing-unilateral');
  });

  it('uses closeUnilateralFromOpen for a never-used (v0) idle channel', async () => {
    const ch = makeChannel('bb', hub, BOB); // hub is userA
    await pool.register(ch, signedState(ch.id, 0n), { amountA: 100n, amountB: 0n });
    await setRecordedAt(ch.id, NOW - 25 * HOUR);

    await sweeper.sweepOnce();

    expect(chain.closeUnilateralFromOpenCalls).toHaveLength(1);
    expect(chain.closeUnilateralFromOpenCalls[0]?.channelId).toBe(ch.id);
    expect(chain.closeUnilateralCalls).toHaveLength(0);
    expect(pool.get(ch.id)?.status).toBe('closing-unilateral');
  });

  it('leaves a recently-active channel open', async () => {
    const ch = makeChannel('cc', ALICE, hub);
    await pool.register(ch, signedState(ch.id, 1n), { amountA: 100n, amountB: 0n });
    await setRecordedAt(ch.id, NOW - 1 * HOUR);

    await sweeper.sweepOnce();

    expect(chain.closeUnilateralCalls).toHaveLength(0);
    expect(chain.closeUnilateralFromOpenCalls).toHaveLength(0);
    expect(pool.get(ch.id)?.status).toBe('open');
  });

  it('skips idle channels with in-flight HTLCs', async () => {
    const htlc: Htlc = {
      id: chId('h1'),
      direction: 'AtoB',
      amount: 5n,
      paymentHash: chId('ph'),
      expiryMs: BigInt(NOW + HOUR),
    };
    const ch = makeChannel('dd', ALICE, hub);
    await pool.register(ch, signedState(ch.id, 2n, [htlc]), { amountA: 100n, amountB: 0n });
    await setRecordedAt(ch.id, NOW - 25 * HOUR);

    await sweeper.sweepOnce();

    expect(chain.closeUnilateralCalls).toHaveLength(0);
    expect(pool.get(ch.id)?.status).toBe('open');
  });

  it('skips channels where the hub is not a party', async () => {
    const ch = makeChannel('ee', ALICE, BOB);
    await pool.register(ch, signedState(ch.id, 1n), { amountA: 100n, amountB: 0n });
    await setRecordedAt(ch.id, NOW - 25 * HOUR);

    await sweeper.sweepOnce();

    expect(chain.closeUnilateralCalls).toHaveLength(0);
    expect(chain.closeUnilateralFromOpenCalls).toHaveLength(0);
    expect(pool.get(ch.id)?.status).toBe('open');
  });

  it('finalizes a closing-unilateral channel once the dispute window elapses', async () => {
    const ch = makeChannel('ff', ALICE, hub, 'closing-unilateral');
    await pool.register(ch);
    onchain.set(ch.id, { disputeDeadlineMs: NOW - 1000, status: 2, htlcsCount: 0 });

    await sweeper.sweepOnce();

    expect(chain.finalizeCalls).toContain(ch.id);
  });

  it('does not finalize before the dispute window elapses', async () => {
    const ch = makeChannel('1a', ALICE, hub, 'closing-unilateral');
    await pool.register(ch);
    onchain.set(ch.id, { disputeDeadlineMs: NOW + HOUR, status: 2, htlcsCount: 0 });

    await sweeper.sweepOnce();

    expect(chain.finalizeCalls).toHaveLength(0);
  });

  it('does not finalize when the posted state still has HTLCs (would enter ResolvingHtlcs)', async () => {
    const ch = makeChannel('1c', ALICE, hub, 'closing-unilateral');
    await pool.register(ch);
    onchain.set(ch.id, { disputeDeadlineMs: NOW - 1000, status: 2, htlcsCount: 1 });

    await sweeper.sweepOnce();

    expect(chain.finalizeCalls).toHaveLength(0);
  });

  it('does not finalize when the on-chain status is no longer ClosingUnilateral', async () => {
    const ch = makeChannel('1d', ALICE, hub, 'closing-unilateral');
    await pool.register(ch);
    // status 4 = Closed (already finalized by someone else); finalize() would revert.
    onchain.set(ch.id, { disputeDeadlineMs: NOW - 1000, status: 4, htlcsCount: 0 });

    await sweeper.sweepOnce();

    expect(chain.finalizeCalls).toHaveLength(0);
  });

  it('records an error and leaves the channel open when the close tx fails', async () => {
    const ch = makeChannel('1b', ALICE, hub);
    await pool.register(ch, signedState(ch.id, 1n), { amountA: 100n, amountB: 0n });
    await setRecordedAt(ch.id, NOW - 25 * HOUR);
    chain.closeUnilateral = async () => {
      throw new Error('rpc down');
    };

    await expect(sweeper.sweepOnce()).resolves.toBeUndefined();

    // Close failed → status untouched, and the error is counted (not swallowed).
    expect(pool.get(ch.id)?.status).toBe('open');
    const counter = await metrics.autoCloseErrorsTotal.get();
    const initiate = counter.values.find((v) => v.labels.phase === 'initiate');
    expect(initiate?.value).toBe(1);
  });

  it('aborts the finalize sweep after a single on-chain read failure (no per-channel flood)', async () => {
    for (const id of ['c1', 'c2', 'c3']) {
      await pool.register(makeChannel(id, ALICE, hub, 'closing-unilateral'));
    }
    onChainReadError = new Error('rpc down');

    await expect(sweeper.sweepOnce()).resolves.toBeUndefined();

    expect(chain.finalizeCalls).toHaveLength(0);
    const counter = await metrics.autoCloseErrorsTotal.get();
    const finalize = counter.values.find((v) => v.labels.phase === 'finalize');
    // Counted once for the whole sweep, not once per closing channel.
    expect(finalize?.value).toBe(1);
  });
});
