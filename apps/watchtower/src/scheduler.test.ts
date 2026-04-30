import type { Address, ChannelId, SignedState } from '@tainnel/protocol';
import Database from 'better-sqlite3';
import type { PublicClient } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FraudDetector } from './detector.js';
import { logger } from './logger.js';
import type { PenaltyResponder } from './responder.js';
import { type ClosingChannelInfo, Scheduler } from './scheduler.js';
import { SqliteWatchtowerStore } from './storage.js';

const channelId = '0x000000000000000000000000000000000000000000000000000000000000000a' as ChannelId;
const paymentChannel = '0x1111111111111111111111111111111111111111' as Address;
const userA = '0x000000000000000000000000000000000000aaaa' as Address;
const userB = '0x000000000000000000000000000000000000bbbb' as Address;

const WINDOW_MS = 86_400_000;

function makeSignedState(version: bigint): SignedState {
  return {
    state: {
      channelId,
      version,
      balanceA: 100n,
      balanceB: 200n,
      htlcs: [],
      finalized: false,
    },
    sigA: {
      r: `0x${'aa'.repeat(32)}` as `0x${string}`,
      s: `0x${'bb'.repeat(32)}` as `0x${string}`,
      v: 27,
    },
    sigB: {
      r: `0x${'cc'.repeat(32)}` as `0x${string}`,
      s: `0x${'dd'.repeat(32)}` as `0x${string}`,
      v: 28,
    },
  };
}

interface MockPublic {
  client: PublicClient;
  getBlockNumber: ReturnType<typeof vi.fn>;
  getContractEvents: ReturnType<typeof vi.fn>;
  getBlock: ReturnType<typeof vi.fn>;
  readContract: ReturnType<typeof vi.fn>;
}

function makeMockPublic(): MockPublic {
  const getBlockNumber = vi.fn();
  const getContractEvents = vi.fn();
  const getBlock = vi.fn();
  const readContract = vi.fn();
  const client = {
    getBlockNumber,
    getContractEvents,
    getBlock,
    readContract,
  } as unknown as PublicClient;
  return { client, getBlockNumber, getContractEvents, getBlock, readContract };
}

interface MockResponder {
  responder: PenaltyResponder;
  submitPenalty: ReturnType<typeof vi.fn>;
}

function makeMockResponder(): MockResponder {
  const submitPenalty = vi.fn().mockResolvedValue('0xdead');
  const responder = { submitPenalty } as unknown as PenaltyResponder;
  return { responder, submitPenalty };
}

describe('Scheduler', () => {
  let db: Database.Database;
  let store: SqliteWatchtowerStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SqliteWatchtowerStore(db);
    store.init();
  });

  afterEach(() => {
    vi.useRealTimers();
    store.close();
    if (db.open) db.close();
  });

  it('A: tick triggers responder when submitByMs is crossed', async () => {
    vi.useFakeTimers();
    const detector = new FraudDetector();
    detector.hydrate([makeSignedState(10n)]);
    const pub = makeMockPublic();
    const { responder, submitPenalty } = makeMockResponder();

    const closingInfo: ClosingChannelInfo = {
      channelId,
      postedVersion: 5n,
      postedAtMs: 0,
      closerSide: 'B',
      disputeDeadlineMs: WINDOW_MS,
      penalized: false,
    };

    const fakeNow = Math.floor(WINDOW_MS * 0.5) + 1;

    const scheduler = new Scheduler({
      detector,
      responder,
      store,
      publicClient: pub.client,
      paymentChannelAddress: paymentChannel,
      logger,
      windowMs: WINDOW_MS,
      thresholdRatio: 0.5,
      now: () => fakeNow,
      closingProvider: () => [closingInfo],
    });

    await scheduler.tick();

    expect(submitPenalty).toHaveBeenCalledTimes(1);
    const call = submitPenalty.mock.calls[0];
    if (!call) throw new Error('submitPenalty was not called');
    expect(call[0]).toBe(channelId);
    expect((call[1] as SignedState).state.version).toBe(10n);
    expect(call[2]).toBe('B');
    expect(typeof call[3]).toBe('number');
  });

  it('B: tick skips when an in-flight tx is already recorded', async () => {
    const detector = new FraudDetector();
    detector.hydrate([makeSignedState(10n)]);
    const pub = makeMockPublic();
    const { responder, submitPenalty } = makeMockResponder();

    store.putInFlight({
      channelId,
      txHash: `0x${'ab'.repeat(32)}` as `0x${string}`,
      submittedAtMs: 1_000,
      nonce: 1,
      maxFeePerGas: 1n,
      attempts: 1,
    });

    const closingInfo: ClosingChannelInfo = {
      channelId,
      postedVersion: 5n,
      postedAtMs: 0,
      closerSide: 'B',
      disputeDeadlineMs: WINDOW_MS,
      penalized: false,
    };

    const fakeNow = Math.floor(WINDOW_MS * 0.5) + 1;

    const scheduler = new Scheduler({
      detector,
      responder,
      store,
      publicClient: pub.client,
      paymentChannelAddress: paymentChannel,
      logger,
      windowMs: WINDOW_MS,
      thresholdRatio: 0.5,
      now: () => fakeNow,
      closingProvider: () => [closingInfo],
    });

    await scheduler.tick();

    expect(submitPenalty).not.toHaveBeenCalled();
  });

  it('C: tick does not submit when the channel is already penalized', async () => {
    const detector = new FraudDetector();
    detector.hydrate([makeSignedState(10n)]);
    const pub = makeMockPublic();
    const { responder, submitPenalty } = makeMockResponder();

    const closingInfo: ClosingChannelInfo = {
      channelId,
      postedVersion: 5n,
      postedAtMs: 0,
      closerSide: 'B',
      disputeDeadlineMs: WINDOW_MS,
      penalized: true,
    };

    const fakeNow = Math.floor(WINDOW_MS * 0.5) + 1;

    const scheduler = new Scheduler({
      detector,
      responder,
      store,
      publicClient: pub.client,
      paymentChannelAddress: paymentChannel,
      logger,
      windowMs: WINDOW_MS,
      thresholdRatio: 0.5,
      now: () => fakeNow,
      closingProvider: () => [closingInfo],
    });

    await scheduler.tick();

    expect(submitPenalty).not.toHaveBeenCalled();
  });

  it('D: catchup submits for events in-window and persists last_processed_block_number', async () => {
    const detector = new FraudDetector();
    detector.hydrate([makeSignedState(10n)]);
    const pub = makeMockPublic();
    const { responder, submitPenalty } = makeMockResponder();

    pub.getBlockNumber.mockResolvedValueOnce(100n);
    pub.getContractEvents.mockResolvedValueOnce([
      {
        args: {
          channelId,
          postedVersion: 5n,
          disputeDeadline: 1_000n,
        },
        blockNumber: 50n,
      },
    ]);
    pub.getBlock.mockResolvedValueOnce({ timestamp: 1_000n });
    pub.readContract.mockResolvedValueOnce([
      userA,
      userB,
      '0x0000000000000000000000000000000000000000' as Address,
      0n,
      0n,
      0n,
      0n,
      5n,
      0n,
      0n,
      false,
      0,
      userA,
    ]);

    const fakeNow = 1_000 * 1_000 + Math.floor(WINDOW_MS * 0.5) + 1;

    const scheduler = new Scheduler({
      detector,
      responder,
      store,
      publicClient: pub.client,
      paymentChannelAddress: paymentChannel,
      logger,
      windowMs: WINDOW_MS,
      thresholdRatio: 0.5,
      now: () => fakeNow,
      closingProvider: () => [],
    });

    await scheduler.catchup();

    expect(submitPenalty).toHaveBeenCalledTimes(1);
    const call = submitPenalty.mock.calls[0];
    if (!call) throw new Error('submitPenalty was not called');
    expect(call[0]).toBe(channelId);
    expect((call[1] as SignedState).state.version).toBe(10n);
    expect(call[2]).toBe('A');
    expect(store.getMeta('last_processed_block_number')).toBe('100');
  });
});
