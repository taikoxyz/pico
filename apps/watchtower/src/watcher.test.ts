import type { ChannelId, Hex } from '@tainnel/protocol';
import type { Log, PublicClient } from 'viem';
import { taiko } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from './logger.js';
import { ChainEventWatcher, type WatcherEvent } from './watcher.js';

const channelId = '0x0000000000000000000000000000000000000000000000000000000000000aaa' as ChannelId;
const contractAddress = '0x07B32f52523Fdf0780821595422DccEF31FA2335' as `0x${string}`;

interface FakeClient {
  blockNumber: bigint;
  emit: (logs: Log[]) => void;
  fail: (err: Error) => void;
  client: PublicClient;
}

function makeFakeClient(initialBlock = 100n): FakeClient {
  let onLogs: ((logs: Log[]) => void) | undefined;
  let onError: ((err: Error) => void) | undefined;
  const handle: FakeClient = {
    blockNumber: initialBlock,
    emit: (logs) => {
      onLogs?.(logs);
    },
    fail: (err) => {
      onError?.(err);
    },
    client: {
      watchContractEvent: ({
        onLogs: ol,
        onError: oe,
      }: {
        onLogs: (logs: Log[]) => void;
        onError: (err: Error) => void;
      }) => {
        onLogs = ol;
        onError = oe;
        return () => {
          onLogs = undefined;
          onError = undefined;
        };
      },
      getBlockNumber: async () => handle.blockNumber,
    } as unknown as PublicClient,
  };
  return handle;
}

function makeLog(
  eventName: string,
  args: Record<string, unknown>,
  block: bigint,
  logIndex = 0,
): Log {
  return {
    eventName,
    args,
    blockNumber: block,
    logIndex,
    transactionHash: `0x${'a'.repeat(64)}` as Hex,
    address: contractAddress,
    blockHash: `0x${'b'.repeat(64)}` as Hex,
    data: '0x' as Hex,
    topics: [],
    transactionIndex: 0,
    removed: false,
  } as unknown as Log;
}

describe('ChainEventWatcher', () => {
  let fake: FakeClient;
  let received: WatcherEvent[];
  let watcher: ChainEventWatcher;

  beforeEach(() => {
    fake = makeFakeClient(100n);
    received = [];
    watcher = new ChainEventWatcher({
      rpcUrl: 'http://nope',
      chain: taiko,
      contractAddress,
      logger,
      client: fake.client,
      pollIntervalMs: 10_000,
      confirmations: 3,
    });
  });

  afterEach(async () => {
    await watcher.stop();
  });

  it('fires handler only after 3 confirmations', async () => {
    await watcher.start(async (e) => {
      received.push(e);
    });
    fake.emit([
      makeLog(
        'ChannelClosingUnilateral',
        {
          channelId,
          postedVersion: 5n,
          disputeDeadline: 9_999_999n,
        },
        100n,
      ),
    ]);
    // bump block but only by 1: not yet enough
    fake.blockNumber = 101n;
    await (watcher as unknown as { advance: (h: () => void) => Promise<void> }).advance(
      () => undefined,
    );
    expect(received).toHaveLength(0);
    fake.blockNumber = 103n;
    await (
      watcher as unknown as { advance: (h: (e: WatcherEvent) => void) => Promise<void> }
    ).advance(async (e: WatcherEvent) => {
      received.push(e);
    });
    expect(received).toHaveLength(1);
    expect(received[0]?.kind).toBe('closeUnilateral');
    expect(received[0]?.version).toBe(5n);
  });

  it('filters by interestedChannelIds', async () => {
    const allowed = new Set<ChannelId>([channelId]);
    const otherId =
      '0x0000000000000000000000000000000000000000000000000000000000000bbb' as ChannelId;
    const filtered = new ChainEventWatcher({
      rpcUrl: 'http://nope',
      chain: taiko,
      contractAddress,
      logger,
      client: fake.client,
      pollIntervalMs: 10_000,
      confirmations: 1,
      interestedChannelIds: allowed,
    });
    await filtered.start(async (e) => {
      received.push(e);
    });
    fake.emit([
      makeLog('DisputeRaised', { channelId: otherId, challengerVersion: 1n }, 100n, 0),
      makeLog('DisputeRaised', { channelId, challengerVersion: 2n }, 100n, 1),
    ]);
    fake.blockNumber = 102n;
    await (
      filtered as unknown as { advance: (h: (e: WatcherEvent) => void) => Promise<void> }
    ).advance(async (e: WatcherEvent) => {
      received.push(e);
    });
    expect(received).toHaveLength(1);
    expect(received[0]?.channelId).toBe(channelId);
    await filtered.stop();
  });

  it('exposes rpcUp + lastBlock', async () => {
    await watcher.start(async () => undefined);
    fake.blockNumber = 105n;
    await (
      watcher as unknown as { advance: (h: (e: WatcherEvent) => void) => Promise<void> }
    ).advance(async () => undefined);
    expect(watcher.isRpcUp()).toBe(true);
    expect(watcher.getLastBlock()).toBe(105n);
  });

  it('marks rpcUp = false on errors and retries', async () => {
    vi.useFakeTimers();
    try {
      await watcher.start(async (e) => {
        received.push(e);
      });
      fake.fail(new Error('rpc dropped'));
      expect(watcher.isRpcUp()).toBe(false);
      await vi.advanceTimersByTimeAsync(500);
      expect(watcher.isRpcUp()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
