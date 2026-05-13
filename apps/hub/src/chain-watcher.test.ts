import type { Channel, ChannelState, Signature, SignedState } from '@inferenceroom/pico-protocol';
import { Registry } from 'prom-client';
import type { PublicClient } from 'viem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChainWatcher } from './chain-watcher.js';
import { ChannelPool } from './channel-pool.js';
import { type TestDb, makeTestDb } from './db/repos/_test-helpers.js';
import type { DisputeHandler, DisputeNotification } from './dispute-handler.js';
import { logger } from './logger.js';
import { type HubMetrics, buildMetrics } from './metrics.js';

const ZERO_SIG: Signature = { r: `0x${'00'.repeat(32)}`, s: `0x${'00'.repeat(32)}`, v: 27 };

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

function signed(version: bigint): SignedState {
  const state: ChannelState = {
    channelId: SAMPLE.id,
    version,
    balanceA: 100n,
    balanceB: 0n,
    htlcs: [],
    htlcsCount: 0,
    htlcsTotalLocked: 0n,
    finalized: false,
  };
  return { state, sigA: ZERO_SIG, sigB: ZERO_SIG };
}

interface FakeLog {
  readonly event: 'opened' | 'closing' | 'disputed' | 'finalized';
  readonly channelId: `0x${string}`;
  readonly args?: Record<string, unknown>;
  readonly blockNumber: bigint;
}

class FakeClient {
  head = 100n;
  logs: FakeLog[] = [];
  blockTimestamps = new Map<bigint, bigint>();
  constructor(args: { head?: bigint; logs?: FakeLog[] } = {}) {
    if (args.head !== undefined) this.head = args.head;
    if (args.logs) this.logs = args.logs;
  }
  async getBlockNumber(): Promise<bigint> {
    return this.head;
  }
  async getBlock(opts: { blockNumber: bigint }): Promise<{
    hash: `0x${string}`;
    timestamp: bigint;
  }> {
    return {
      hash: `0x${opts.blockNumber.toString(16).padStart(64, '0')}` as `0x${string}`,
      timestamp: this.blockTimestamps.get(opts.blockNumber) ?? 1_700_000_000n,
    };
  }
  async getLogs(opts: {
    fromBlock: bigint;
    toBlock: bigint;
    event?: { name?: string };
  }): Promise<unknown[]> {
    const name = opts.event?.name;
    const filter = (e: FakeLog) =>
      e.blockNumber >= opts.fromBlock &&
      e.blockNumber <= opts.toBlock &&
      ((name === 'ChannelOpened' && e.event === 'opened') ||
        (name === 'ChannelClosingUnilateral' && e.event === 'closing') ||
        (name === 'DisputeRaised' && e.event === 'disputed') ||
        (name === 'ChannelFinalized' && e.event === 'finalized'));
    return this.logs.filter(filter).map((e) => ({
      args: { channelId: e.channelId, ...(e.args ?? {}) },
      blockNumber: e.blockNumber,
    }));
  }
}

class FakeDisputeHandler {
  notifications: DisputeNotification[] = [];
  async handle(n: DisputeNotification): Promise<void> {
    this.notifications.push(n);
  }
}

describe('ChainWatcher', () => {
  let h: TestDb;
  let pool: ChannelPool;
  let metrics: HubMetrics;

  beforeEach(async () => {
    h = await makeTestDb();
    pool = new ChannelPool({
      logger,
      channelRepo: h.repos.channels,
      stateRepo: h.repos.states,
    });
    await pool.register(SAMPLE, signed(1n));
    metrics = buildMetrics(new Registry());
  });
  afterEach(async () => h.cleanup());

  it('promotes pending → open on ChannelOpened', async () => {
    const client = new FakeClient({
      head: 10n,
      logs: [{ event: 'opened', channelId: SAMPLE.id, blockNumber: 5n }],
    });
    const watcher = new ChainWatcher({
      rpcUrl: 'http://test',
      logger,
      channelPool: pool,
      repos: h.repos,
      paymentChannelAddress: SAMPLE.contract,
      metrics,
      disputeHandler: new FakeDisputeHandler() as unknown as DisputeHandler,
      chainId: 31337,
      pollingIntervalMs: 60_000,
      confirmations: 3,
      publicClient: client as unknown as PublicClient,
    });
    await watcher.pollOnce();
    expect(pool.get(SAMPLE.id)?.status).toBe('open');
  });

  it('hands ClosingUnilateral to the dispute handler', async () => {
    const client = new FakeClient({
      head: 10n,
      logs: [
        {
          event: 'closing',
          channelId: SAMPLE.id,
          args: { postedVersion: 3n, disputeDeadline: 0n },
          blockNumber: 5n,
        },
      ],
    });
    const fakeDispute = new FakeDisputeHandler();
    const watcher = new ChainWatcher({
      rpcUrl: 'http://test',
      logger,
      channelPool: pool,
      repos: h.repos,
      paymentChannelAddress: SAMPLE.contract,
      metrics,
      disputeHandler: fakeDispute as unknown as DisputeHandler,
      chainId: 31337,
      pollingIntervalMs: 60_000,
      confirmations: 3,
      publicClient: client as unknown as PublicClient,
    });
    await watcher.pollOnce();
    expect(pool.get(SAMPLE.id)?.status).toBe('closing-unilateral');
    expect(fakeDispute.notifications).toHaveLength(1);
    expect(fakeDispute.notifications[0]?.attackerVersion).toBe(3n);
  });

  it('bootstraps an unknown channel from a ChannelOpened event', async () => {
    const newChannelId = '0xbb';
    const newUserB: `0x${string}` = '0x00000000000000000000000000000000000000B1';
    const client = new FakeClient({
      head: 10n,
      logs: [
        {
          event: 'opened',
          channelId: newChannelId,
          args: {
            userA: SAMPLE.userA,
            userB: newUserB,
            token: SAMPLE.token,
            amountA: 1234n,
            amountB: 0n,
          },
          blockNumber: 5n,
        },
      ],
    });
    client.blockTimestamps.set(5n, 1_800_000_000n);
    const watcher = new ChainWatcher({
      rpcUrl: 'http://test',
      logger,
      channelPool: pool,
      repos: h.repos,
      paymentChannelAddress: SAMPLE.contract,
      metrics,
      disputeHandler: new FakeDisputeHandler() as unknown as DisputeHandler,
      chainId: 31337,
      pollingIntervalMs: 60_000,
      confirmations: 3,
      publicClient: client as unknown as PublicClient,
    });
    expect(pool.get(newChannelId)).toBeUndefined();
    await watcher.pollOnce();
    const bootstrapped = pool.get(newChannelId);
    expect(bootstrapped).toBeDefined();
    expect(bootstrapped?.status).toBe('open');
    expect(bootstrapped?.userA).toBe(SAMPLE.userA);
    expect(bootstrapped?.userB).toBe(newUserB);
    expect(bootstrapped?.token).toBe(SAMPLE.token);
    expect(bootstrapped?.contract).toBe(SAMPLE.contract);
    expect(bootstrapped?.chainId).toBe(31337);
    expect(bootstrapped?.openedAt).toBe(1_800_000_000_000n);
    expect(bootstrapped?.disputeWindowMs).toBe(86_400_000);
    const amounts = await h.repos.channels.getAmounts(newChannelId);
    expect(amounts?.amountA).toBe(1234n);
    expect(amounts?.amountB).toBe(0n);
  });

  it('respects the confirmation buffer', async () => {
    const client = new FakeClient({
      head: 5n,
      logs: [{ event: 'opened', channelId: SAMPLE.id, blockNumber: 5n }],
    });
    const watcher = new ChainWatcher({
      rpcUrl: 'http://test',
      logger,
      channelPool: pool,
      repos: h.repos,
      paymentChannelAddress: SAMPLE.contract,
      metrics,
      disputeHandler: new FakeDisputeHandler() as unknown as DisputeHandler,
      chainId: 31337,
      pollingIntervalMs: 60_000,
      confirmations: 3,
      publicClient: client as unknown as PublicClient,
    });
    await h.repos.kv.set('chain_watcher.last_processed_block', '0');
    await watcher.pollOnce();
    expect(pool.get(SAMPLE.id)?.status).toBe('pending');
    client.head = 10n;
    await watcher.pollOnce();
    expect(pool.get(SAMPLE.id)?.status).toBe('open');
  });
});
