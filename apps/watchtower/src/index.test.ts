import type {
  Address,
  ChannelId,
  ChannelState,
  Hex,
  SignedState,
} from '@inferenceroom/pico-protocol';
import { hexToSignature } from '@inferenceroom/pico-sdk';
import { buildChannelStateTypedData } from '@inferenceroom/pico-state-machine';
import type { PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type WatchtowerHandle, startWatchtower } from './index.js';

const PAYMENT_CHANNEL = '0x1111111111111111111111111111111111111111' as Address;
const CHAIN_ID = 31337;
const PK_A = `0x${'aa'.repeat(32)}` as Hex;
const PK_B = `0x${'bb'.repeat(32)}` as Hex;
const accountA = privateKeyToAccount(PK_A);
const accountB = privateKeyToAccount(PK_B);
const USER_A = accountA.address;
const USER_B = accountB.address;
const FAKE_PRIVATE_KEY = `0x${'11'.repeat(32)}` as Hex;
const CHANNEL_ID =
  '0x000000000000000000000000000000000000000000000000000000000000000a' as ChannelId;

async function makeRealSignedState(version: bigint): Promise<SignedState> {
  const state: ChannelState = {
    channelId: CHANNEL_ID,
    version,
    balanceA: 100n,
    balanceB: 200n,
    htlcs: [],
    finalized: false,
  };
  const data = buildChannelStateTypedData(state, CHAIN_ID, PAYMENT_CHANNEL);
  const sigA = await accountA.signTypedData(data);
  const sigB = await accountB.signTypedData(data);
  return { state, sigA: hexToSignature(sigA), sigB: hexToSignature(sigB) };
}

function makeMockPublicClient(): PublicClient {
  const watchContractEvent = vi.fn(() => () => {});
  const getBlockNumber = vi.fn(async () => 1n);
  const getContractEvents = vi.fn(async () => []);
  const readContract = vi.fn(async (args: { functionName: string }) => {
    if (args.functionName === 'adjudicator') return PAYMENT_CHANNEL;
    return [
      USER_A,
      USER_B,
      '0x0000000000000000000000000000000000000000' as Address,
      100n,
      200n,
      0n,
      0n,
      0n,
      0n,
      0n,
      false,
      0,
      USER_A,
    ];
  });
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
      chainId: CHAIN_ID,
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

  it('uses configured HTTP host for health and metrics listener', async () => {
    const publicClient = makeMockPublicClient();
    handle = await startWatchtower({
      rpcUrl: 'http://127.0.0.1:1',
      privateKey: FAKE_PRIVATE_KEY,
      paymentChannelAddress: PAYMENT_CHANNEL,
      chainId: CHAIN_ID,
      publicClient,
      startHttp: true,
      httpHost: '::',
    });

    expect(handle.httpUrl).toMatch(/^http:\/\/\[::\]:\d+$/);
  });

  it('remember(state) persists to both store and detector after EIP-712 validation', async () => {
    const publicClient = makeMockPublicClient();
    handle = await startWatchtower({
      rpcUrl: 'http://127.0.0.1:1',
      privateKey: FAKE_PRIVATE_KEY,
      paymentChannelAddress: PAYMENT_CHANNEL,
      chainId: CHAIN_ID,
      publicClient,
      startHttp: false,
    });

    const state = await makeRealSignedState(7n);
    await handle.remember(state);

    const fromDetector = handle.detector.getLatest(CHANNEL_ID);
    expect(fromDetector?.state.version).toBe(7n);

    const allStored = handle.store.loadAllSignedStates();
    expect(allStored.length).toBe(1);
    expect(allStored[0]?.state.version).toBe(7n);
  });

  it('remember(state) rejects forged signatures and preserves prior evidence', async () => {
    const publicClient = makeMockPublicClient();
    handle = await startWatchtower({
      rpcUrl: 'http://127.0.0.1:1',
      privateKey: FAKE_PRIVATE_KEY,
      paymentChannelAddress: PAYMENT_CHANNEL,
      chainId: CHAIN_ID,
      publicClient,
      startHttp: false,
    });

    const good = await makeRealSignedState(5n);
    await handle.remember(good);

    const tampered: SignedState = {
      ...good,
      state: { ...good.state, version: 6n },
    };
    await expect(handle.remember(tampered)).rejects.toThrow(/sig[AB] does not verify/);
    expect(handle.detector.getLatest(CHANNEL_ID)?.state.version).toBe(5n);
  });

  it('stop() resolves cleanly', async () => {
    const publicClient = makeMockPublicClient();
    handle = await startWatchtower({
      rpcUrl: 'http://127.0.0.1:1',
      privateKey: FAKE_PRIVATE_KEY,
      paymentChannelAddress: PAYMENT_CHANNEL,
      chainId: CHAIN_ID,
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
      chainId: CHAIN_ID,
      publicClient,
      startHttp: false,
    });
    await handle.remember(await makeRealSignedState(3n));
    expect(handle.detector.getLatest(CHANNEL_ID)?.state.version).toBe(3n);
  });
});
