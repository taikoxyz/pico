import type { Address } from '@tainnel/protocol';
import type { PublicClient } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from './logger.js';
import * as metrics from './metrics.js';
import { ChainEventWatcher, type WatcherEvent } from './watcher.js';

interface CapturedSubscription {
  readonly eventName: string;
  readonly onLogs: (logs: unknown[]) => void;
  readonly onError: (err: unknown) => void;
  unwatched: boolean;
}

interface MockPublicClient {
  watchContractEvent: ReturnType<typeof vi.fn>;
  getBlockNumber: ReturnType<typeof vi.fn>;
  getTransactionReceipt: ReturnType<typeof vi.fn>;
  subscriptions: CapturedSubscription[];
  setHead(n: bigint): void;
  receiptForHash: Map<string, unknown>;
}

function makeMockClient(): MockPublicClient {
  const subscriptions: CapturedSubscription[] = [];
  let head = 0n;
  const receiptForHash = new Map<string, unknown>();

  const watchContractEvent = vi.fn(
    (args: {
      eventName: string;
      onLogs: (logs: unknown[]) => void;
      onError: (err: unknown) => void;
    }) => {
      const sub: CapturedSubscription = {
        eventName: args.eventName,
        onLogs: args.onLogs,
        onError: args.onError,
        unwatched: false,
      };
      subscriptions.push(sub);
      return () => {
        sub.unwatched = true;
      };
    },
  );

  const getBlockNumber = vi.fn(async () => head);
  const getTransactionReceipt = vi.fn(async ({ hash }: { hash: string }) => {
    if (!receiptForHash.has(hash)) throw new Error('no receipt');
    return receiptForHash.get(hash);
  });

  return {
    watchContractEvent,
    getBlockNumber,
    getTransactionReceipt,
    subscriptions,
    receiptForHash,
    setHead(n: bigint) {
      head = n;
    },
  };
}

const PAYMENT_CHANNEL = '0x1111111111111111111111111111111111111111' as Address;
const CHANNEL_A =
  '0x000000000000000000000000000000000000000000000000000000000000000a' as `0x${string}`;
const CHANNEL_B =
  '0x000000000000000000000000000000000000000000000000000000000000000b' as `0x${string}`;

function makeClosingLog(
  channelId: `0x${string}`,
  blockNumber: bigint,
  txHash: `0x${string}`,
  postedVersion = 1n,
): unknown {
  return {
    args: {
      channelId,
      postedVersion,
      disputeDeadline: 1_000_000n,
    },
    transactionHash: txHash,
    blockNumber,
  };
}

function getSubscription(client: MockPublicClient, eventName: string): CapturedSubscription {
  const sub = client.subscriptions.find((s) => s.eventName === eventName);
  if (!sub) throw new Error(`no subscription for ${eventName}`);
  return sub;
}

const silentLogger = {
  ...logger,
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as typeof logger;

describe('ChainEventWatcher', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('A: gates handler dispatch on confirmations', async () => {
    const client = makeMockClient();
    const watcher = new ChainEventWatcher({
      rpcUrl: 'http://localhost',
      paymentChannelAddress: PAYMENT_CHANNEL,
      chainId: 31337,
      logger: silentLogger,
      publicClient: client as unknown as PublicClient,
      confirmations: 3,
    });
    const handler = vi.fn(async (_e: WatcherEvent) => {});
    await watcher.start(handler);

    const txHash =
      '0xaaaa000000000000000000000000000000000000000000000000000000000001' as `0x${string}`;
    client.receiptForHash.set(txHash, { status: 'success', transactionHash: txHash });
    client.setHead(11n);

    const sub = getSubscription(client, 'ChannelClosingUnilateral');
    sub.onLogs([makeClosingLog(CHANNEL_A, 10n, txHash)]);
    await watcher.__forFlush();
    expect(handler).not.toHaveBeenCalled();

    client.setHead(13n);
    await watcher.__forFlush();
    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0]?.[0];
    if (!event) throw new Error('handler was not invoked');
    expect(event.kind).toBe('closeUnilateral');
    expect(event.channelId).toBe(CHANNEL_A);
    expect(watcher.lastEventBlockNumber()).toBe(13n);

    await watcher.stop();
  });

  it('B: drops reorg-evicted events when receipt is missing', async () => {
    const client = makeMockClient();
    const watcher = new ChainEventWatcher({
      rpcUrl: 'http://localhost',
      paymentChannelAddress: PAYMENT_CHANNEL,
      chainId: 31337,
      logger: silentLogger,
      publicClient: client as unknown as PublicClient,
      confirmations: 3,
    });
    const handler = vi.fn(async (_e: WatcherEvent) => {});
    await watcher.start(handler);

    const txHash =
      '0xbbbb000000000000000000000000000000000000000000000000000000000002' as `0x${string}`;

    const sub = getSubscription(client, 'ChannelClosingUnilateral');
    client.setHead(10n);
    sub.onLogs([makeClosingLog(CHANNEL_A, 10n, txHash)]);
    await watcher.__forFlush();
    expect(handler).not.toHaveBeenCalled();

    client.setHead(13n);
    await watcher.__forFlush();
    expect(handler).not.toHaveBeenCalled();

    client.setHead(20n);
    await watcher.__forFlush();
    expect(handler).not.toHaveBeenCalled();

    await watcher.stop();
  });

  it('C: filters by interestedChannelIds', async () => {
    const interested = new Set<`0x${string}`>([CHANNEL_A]);
    const client = makeMockClient();
    const watcher = new ChainEventWatcher({
      rpcUrl: 'http://localhost',
      paymentChannelAddress: PAYMENT_CHANNEL,
      chainId: 31337,
      logger: silentLogger,
      publicClient: client as unknown as PublicClient,
      confirmations: 3,
      interestedChannelIds: interested,
    });
    const handler = vi.fn(async (_e: WatcherEvent) => {});
    await watcher.start(handler);

    const txA =
      '0xaaaa000000000000000000000000000000000000000000000000000000000010' as `0x${string}`;
    const txB =
      '0xbbbb000000000000000000000000000000000000000000000000000000000011' as `0x${string}`;
    client.receiptForHash.set(txA, { status: 'success', transactionHash: txA });
    client.receiptForHash.set(txB, { status: 'success', transactionHash: txB });

    const sub = getSubscription(client, 'ChannelClosingUnilateral');
    client.setHead(10n);
    sub.onLogs([makeClosingLog(CHANNEL_A, 10n, txA), makeClosingLog(CHANNEL_B, 10n, txB)]);
    await watcher.__forFlush();
    expect(handler).not.toHaveBeenCalled();

    client.setHead(13n);
    await watcher.__forFlush();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]?.channelId).toBe(CHANNEL_A);

    await watcher.stop();
  });

  it('D: toggles rpcUp metric on disconnect and reconnect', async () => {
    vi.useFakeTimers();
    const client = makeMockClient();
    const watcher = new ChainEventWatcher({
      rpcUrl: 'http://localhost',
      paymentChannelAddress: PAYMENT_CHANNEL,
      chainId: 31337,
      logger: silentLogger,
      publicClient: client as unknown as PublicClient,
      confirmations: 3,
    });
    const handler = vi.fn(async (_e: WatcherEvent) => {});
    await watcher.start(handler);

    expect((await metrics.rpcUp.get()).values[0]?.value).toBe(1);
    expect(watcher.isConnected()).toBe(true);

    const sub = getSubscription(client, 'ChannelClosingUnilateral');
    sub.onError(new Error('rpc gone'));

    expect((await metrics.rpcUp.get()).values[0]?.value).toBe(0);
    expect(watcher.isConnected()).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    expect((await metrics.rpcUp.get()).values[0]?.value).toBe(1);
    expect(watcher.isConnected()).toBe(true);

    await watcher.stop();
  });

  it('E: schedules reconnects with exponential backoff', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const client = makeMockClient();
    const watcher = new ChainEventWatcher({
      rpcUrl: 'http://localhost',
      paymentChannelAddress: PAYMENT_CHANNEL,
      chainId: 31337,
      logger: silentLogger,
      publicClient: client as unknown as PublicClient,
      confirmations: 3,
    });
    const handler = vi.fn(async (_e: WatcherEvent) => {});
    await watcher.start(handler);

    client.watchContractEvent.mockImplementation(() => {
      throw new Error('still down');
    });

    setTimeoutSpy.mockClear();

    const sub = getSubscription(client, 'ChannelClosingUnilateral');
    sub.onError(new Error('rpc down'));

    const reconnectCalls = () =>
      setTimeoutSpy.mock.calls.filter((c) => {
        const delay = c[1] as number;
        return typeof delay === 'number' && delay <= 30_000;
      });

    const firstDelay = reconnectCalls()[0]?.[1] as number;
    expect(firstDelay).toBeGreaterThanOrEqual(225);
    expect(firstDelay).toBeLessThanOrEqual(275);

    await vi.advanceTimersByTimeAsync(firstDelay + 5);

    const secondDelay = reconnectCalls()[1]?.[1] as number;
    expect(secondDelay).toBeGreaterThanOrEqual(450);
    expect(secondDelay).toBeLessThanOrEqual(550);

    await vi.advanceTimersByTimeAsync(secondDelay + 5);

    const thirdDelay = reconnectCalls()[2]?.[1] as number;
    expect(thirdDelay).toBeGreaterThanOrEqual(900);
    expect(thirdDelay).toBeLessThanOrEqual(1100);

    await watcher.stop();
  });
});
