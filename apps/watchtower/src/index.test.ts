import type { Address, ChannelId, Hex, SignedState } from '@tainnel/protocol';
import type { PublicClient } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type WatchtowerHandle, startWatchtower } from './index.js';

const PAYMENT_CHANNEL = '0x1111111111111111111111111111111111111111' as Address;
const USER_A = '0x000000000000000000000000000000000000aaaa' as Address;
const USER_B = '0x000000000000000000000000000000000000bbbb' as Address;
const FAKE_PRIVATE_KEY = `0x${'11'.repeat(32)}` as Hex;
const CHANNEL_ID =
  '0x000000000000000000000000000000000000000000000000000000000000000a' as ChannelId;

function makeSignedState(version: bigint): SignedState {
  return {
    state: {
      channelId: CHANNEL_ID,
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

function makeMockPublicClient(): PublicClient {
  const watchContractEvent = vi.fn(() => () => {});
  const getBlockNumber = vi.fn(async () => 1n);
  const getContractEvents = vi.fn(async () => []);
  const readContract = vi.fn(async () => [
    USER_A,
    USER_B,
    '0x0000000000000000000000000000000000000000' as Address,
    0n,
    0n,
    0n,
    0n,
    0n,
    0n,
    0n,
    false,
    0,
    USER_A,
  ]);
  return {
    watchContractEvent,
    getBlockNumber,
    getContractEvents,
    readContract,
  } as unknown as PublicClient;
}

describe('startWatchtower wiring', () => {
  let handle: WatchtowerHandle | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.stop();
      handle = undefined;
    }
  });

  it('composes detector, responder, watcher, scheduler, store, and http', async () => {
    const publicClient = makeMockPublicClient();
    handle = await startWatchtower({
      rpcUrl: 'http://127.0.0.1:1',
      privateKey: FAKE_PRIVATE_KEY,
      paymentChannelAddress: PAYMENT_CHANNEL,
      chainId: 31337,
      publicClient,
      startHttp: true,
    });

    expect(handle.detector).toBeDefined();
    expect(handle.responder).toBeDefined();
    expect(handle.watcher).toBeDefined();
    expect(handle.scheduler).toBeDefined();
    expect(handle.store).toBeDefined();
    expect(handle.http).toBeDefined();
    expect(typeof handle.httpUrl).toBe('string');
    expect(handle.httpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    expect(handle.watcher.isConnected()).toBe(true);

    const res = await handle.http?.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      rpc: { up: boolean; lastEventBlockNumber: string | null };
      db: { up: boolean };
      channelsWatched: number;
    };
    expect(body.rpc.up).toBe(true);
    expect(body.db.up).toBe(true);
    expect(body.channelsWatched).toBe(0);
  });

  it('remember(state) persists to both store and detector', async () => {
    const publicClient = makeMockPublicClient();
    handle = await startWatchtower({
      rpcUrl: 'http://127.0.0.1:1',
      privateKey: FAKE_PRIVATE_KEY,
      paymentChannelAddress: PAYMENT_CHANNEL,
      chainId: 31337,
      publicClient,
      startHttp: false,
    });

    const state = makeSignedState(7n);
    handle.remember(state);

    const fromDetector = handle.detector.getLatest(CHANNEL_ID);
    expect(fromDetector?.state.version).toBe(7n);

    const allStored = handle.store.loadAllSignedStates();
    expect(allStored.length).toBe(1);
    expect(allStored[0]?.state.version).toBe(7n);
  });

  it('stop() resolves cleanly even when called twice would be unsafe (single call)', async () => {
    const publicClient = makeMockPublicClient();
    handle = await startWatchtower({
      rpcUrl: 'http://127.0.0.1:1',
      privateKey: FAKE_PRIVATE_KEY,
      paymentChannelAddress: PAYMENT_CHANNEL,
      chainId: 31337,
      publicClient,
      startHttp: false,
    });

    await expect(handle.stop()).resolves.toBeUndefined();
    handle = undefined;
  });

  it('hydrates detector from existing store rows on startup', async () => {
    const publicClient = makeMockPublicClient();
    handle = await startWatchtower({
      rpcUrl: 'http://127.0.0.1:1',
      privateKey: FAKE_PRIVATE_KEY,
      paymentChannelAddress: PAYMENT_CHANNEL,
      chainId: 31337,
      publicClient,
      startHttp: false,
    });
    handle.remember(makeSignedState(3n));
    expect(handle.detector.getLatest(CHANNEL_ID)?.state.version).toBe(3n);
  });
});
