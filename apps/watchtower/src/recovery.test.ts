import type { Address, ChannelId, ChannelState, Hex, SignedState } from '@pico/protocol';
import { hexToSignature } from '@pico/sdk';
import { buildChannelStateTypedData } from '@pico/state-machine';
import Database from 'better-sqlite3';
import type { Hash, PublicClient, WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FraudDetector } from './detector.js';
import { type WatchtowerHandle, startWatchtower } from './index.js';
import { logger } from './logger.js';
import { PenaltyResponder } from './responder.js';
import { type ClosingChannelInfo, Scheduler } from './scheduler.js';
import { SqliteWatchtowerStore } from './storage.js';

const PAYMENT_CHANNEL = '0x1111111111111111111111111111111111111111' as Address;
const CHANNEL_ID =
  '0x000000000000000000000000000000000000000000000000000000000000000a' as ChannelId;
const CHAIN_ID = 31337;
const PK_A = `0x${'a1'.repeat(32)}` as Hex;
const PK_B = `0x${'b2'.repeat(32)}` as Hex;
const PK_X = `0x${'cd'.repeat(32)}` as Hex;
const accountA = privateKeyToAccount(PK_A);
const accountB = privateKeyToAccount(PK_B);
const accountX = privateKeyToAccount(PK_X);
const USER_A = accountA.address;
const USER_B = accountB.address;
const FAKE_PRIVATE_KEY = `0x${'11'.repeat(32)}` as Hex;
const WINDOW_MS = 86_400_000;

async function buildSignedState(
  version: bigint,
  overrides: Partial<ChannelState> = {},
  signers: { sigA?: typeof accountA; sigB?: typeof accountB } = {},
): Promise<SignedState> {
  const state: ChannelState = {
    channelId: CHANNEL_ID,
    version,
    balanceA: 100n,
    balanceB: 200n,
    htlcs: [],
    finalized: false,
    ...overrides,
  };
  const data = buildChannelStateTypedData(state, CHAIN_ID, PAYMENT_CHANNEL);
  const signerA = signers.sigA ?? accountA;
  const signerB = signers.sigB ?? accountB;
  const sigA = await signerA.signTypedData(data);
  const sigB = await signerB.signTypedData(data);
  return { state, sigA: hexToSignature(sigA), sigB: hexToSignature(sigB) };
}

function mockPublicClientForChannel(): PublicClient {
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

interface MockResponderPublic {
  client: PublicClient;
  getTransactionReceipt: ReturnType<typeof vi.fn>;
  waitForTransactionReceipt: ReturnType<typeof vi.fn>;
  estimateFeesPerGas: ReturnType<typeof vi.fn>;
  estimateContractGas: ReturnType<typeof vi.fn>;
  getTransactionCount: ReturnType<typeof vi.fn>;
}

function makeResponderMockPublic(): MockResponderPublic {
  const getTransactionReceipt = vi.fn();
  const waitForTransactionReceipt = vi.fn();
  const estimateFeesPerGas = vi
    .fn()
    .mockResolvedValue({ maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 100_000_000n });
  const estimateContractGas = vi.fn().mockResolvedValue(250_000n);
  const getTransactionCount = vi.fn().mockResolvedValue(7);
  const client = {
    getTransactionReceipt,
    waitForTransactionReceipt,
    estimateFeesPerGas,
    estimateContractGas,
    getTransactionCount,
  } as unknown as PublicClient;
  return {
    client,
    getTransactionReceipt,
    waitForTransactionReceipt,
    estimateFeesPerGas,
    estimateContractGas,
    getTransactionCount,
  };
}

function makeMockWallet(): { client: WalletClient; writeContract: ReturnType<typeof vi.fn> } {
  const writeContract = vi.fn();
  const account = {
    address: '0x000000000000000000000000000000000000beef' as Address,
    type: 'local' as const,
  };
  const client = { account, chain: undefined, writeContract } as unknown as WalletClient;
  return { client, writeContract };
}

describe('watchtower recovery', () => {
  let db: Database.Database;
  let store: SqliteWatchtowerStore;
  let handle: WatchtowerHandle | undefined;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SqliteWatchtowerStore(db);
    store.init();
  });

  afterEach(async () => {
    if (handle) {
      await handle.stop();
      handle = undefined;
    }
    vi.useRealTimers();
    store.close();
    if (db.open) db.close();
  });

  it('WTW-002: scheduler defers before threshold; on restart with fresh detector, submits when threshold elapses', async () => {
    const evidence = await buildSignedState(10n);
    const closing: ClosingChannelInfo = {
      channelId: CHANNEL_ID,
      postedVersion: 5n,
      postedAtMs: 0,
      closerSide: 'B',
      disputeDeadlineMs: WINDOW_MS,
      penalized: false,
    };
    const beforeThreshold = Math.floor(WINDOW_MS * 0.5) - 1;
    const afterThreshold = Math.floor(WINDOW_MS * 0.5) + 1;

    const detectorA = new FraudDetector();
    detectorA.hydrate([evidence]);
    const responderA = { submitPenalty: vi.fn().mockResolvedValue('0xdead' as Hash) };
    const schedulerA = new Scheduler({
      detector: detectorA,
      responder: responderA as unknown as PenaltyResponder,
      store,
      publicClient: makeResponderMockPublic().client,
      paymentChannelAddress: PAYMENT_CHANNEL,
      logger,
      windowMs: WINDOW_MS,
      thresholdRatio: 0.5,
      now: () => beforeThreshold,
      closingProvider: () => [closing],
    });
    await schedulerA.tick();
    expect(responderA.submitPenalty).not.toHaveBeenCalled();

    const detectorB = new FraudDetector();
    detectorB.hydrate(store.loadAllSignedStates().concat(evidence));
    const responderB = { submitPenalty: vi.fn().mockResolvedValue('0xdead' as Hash) };
    const schedulerB = new Scheduler({
      detector: detectorB,
      responder: responderB as unknown as PenaltyResponder,
      store,
      publicClient: makeResponderMockPublic().client,
      paymentChannelAddress: PAYMENT_CHANNEL,
      logger,
      windowMs: WINDOW_MS,
      thresholdRatio: 0.5,
      now: () => afterThreshold,
      closingProvider: () => [closing],
    });
    await schedulerB.tick();
    expect(responderB.submitPenalty).toHaveBeenCalledTimes(1);
  });

  it('WTW-003: stale in-flight tx on restart is replaced with same nonce + bumped fee', async () => {
    const inclusionTimeoutMs = 60_000;
    const oldHash = `0x${'aa'.repeat(32)}` as Hash;
    const replacementHash = `0x${'bb'.repeat(32)}` as Hash;

    const obsId = store.recordObservation({
      channelId: CHANNEL_ID,
      postedVersion: 5n,
      postedAtMs: 0,
      ourLatestVersion: 10n,
      actionTaken: 'penalize',
      createdAtMs: 0,
    });
    store.putInFlight({
      channelId: CHANNEL_ID,
      txHash: oldHash,
      submittedAtMs: Date.now() - inclusionTimeoutMs - 5_000,
      nonce: 7,
      maxFeePerGas: 1_000_000_000n,
      attempts: 1,
      observationId: obsId,
    });

    const pub = makeResponderMockPublic();
    pub.getTransactionReceipt.mockResolvedValueOnce(null);
    pub.waitForTransactionReceipt.mockResolvedValueOnce({
      status: 'success',
      transactionHash: replacementHash,
    });
    const wallet = makeMockWallet();
    wallet.writeContract.mockResolvedValueOnce(replacementHash);

    const responder = new PenaltyResponder({
      rpcUrl: 'http://localhost:0',
      privateKey: FAKE_PRIVATE_KEY,
      paymentChannelAddress: PAYMENT_CHANNEL,
      chainId: CHAIN_ID,
      logger,
      publicClient: pub.client,
      walletClient: wallet.client,
      store,
      inclusionTimeoutMs,
    });

    const evidence = await buildSignedState(10n);
    const result = await responder.submitPenalty(CHANNEL_ID, evidence, 'A', obsId);

    expect(result).toBe(replacementHash);
    expect(wallet.writeContract).toHaveBeenCalledTimes(1);
    const args = wallet.writeContract.mock.calls[0]?.[0] as {
      nonce: number;
      maxFeePerGas: bigint;
    };
    expect(args.nonce).toBe(7);
    expect(args.maxFeePerGas >= 1_000_000_000n).toBe(true);
    expect(store.getInFlight(CHANNEL_ID)).toBeUndefined();
  });

  it('WTW-003: stuck tx across multiple scheduler ticks reuses the same nonce on each replacement', async () => {
    const inclusionTimeoutMs = 1_000;
    const pub = makeResponderMockPublic();
    const wallet = makeMockWallet();
    const hashes: Hash[] = [
      `0x${'01'.repeat(32)}` as Hash,
      `0x${'02'.repeat(32)}` as Hash,
      `0x${'03'.repeat(32)}` as Hash,
    ];
    wallet.writeContract
      .mockResolvedValueOnce(hashes[0] as Hash)
      .mockResolvedValueOnce(hashes[1] as Hash)
      .mockResolvedValueOnce(hashes[2] as Hash);
    pub.getTransactionReceipt.mockResolvedValue(null);
    pub.waitForTransactionReceipt.mockRejectedValue(new Error('timeout'));

    const responder = new PenaltyResponder({
      rpcUrl: 'http://localhost:0',
      privateKey: FAKE_PRIVATE_KEY,
      paymentChannelAddress: PAYMENT_CHANNEL,
      chainId: CHAIN_ID,
      logger,
      publicClient: pub.client,
      walletClient: wallet.client,
      store,
      inclusionTimeoutMs,
      maxAttempts: 1,
    });

    const evidence = await buildSignedState(10n);
    let fakeNow = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => fakeNow);

    await expect(responder.submitPenalty(CHANNEL_ID, evidence, 'A')).rejects.toThrow(/timed out/i);
    fakeNow += inclusionTimeoutMs + 1;
    await expect(responder.submitPenalty(CHANNEL_ID, evidence, 'A')).rejects.toThrow(/timed out/i);
    fakeNow += inclusionTimeoutMs + 1;
    await expect(responder.submitPenalty(CHANNEL_ID, evidence, 'A')).rejects.toThrow(/timed out/i);

    vi.spyOn(Date, 'now').mockRestore();

    expect(wallet.writeContract).toHaveBeenCalledTimes(3);
    const nonces = wallet.writeContract.mock.calls.map((c) => (c[0] as { nonce: number }).nonce);
    expect(nonces).toEqual([7, 7, 7]);
    expect(pub.getTransactionCount).toHaveBeenCalledTimes(3);
  });

  it('WTW-006 regression: live close before threshold does not submit; scheduler tick after threshold submits', async () => {
    const start = Date.now();
    const evidence = await buildSignedState(10n);
    const detector = new FraudDetector();
    detector.hydrate([evidence]);
    const submitPenalty = vi.fn().mockResolvedValue('0xdead' as Hash);
    const responder = { submitPenalty } as unknown as PenaltyResponder;

    const closing: ClosingChannelInfo = {
      channelId: CHANNEL_ID,
      postedVersion: 5n,
      postedAtMs: start,
      closerSide: 'A',
      disputeDeadlineMs: start + WINDOW_MS,
      penalized: false,
    };
    const submitByMs = start + Math.floor(WINDOW_MS * 0.5);

    const scheduler = new Scheduler({
      detector,
      responder,
      store,
      publicClient: makeResponderMockPublic().client,
      paymentChannelAddress: PAYMENT_CHANNEL,
      logger,
      windowMs: WINDOW_MS,
      thresholdRatio: 0.5,
      now: () => submitByMs - 1,
      closingProvider: () => [closing],
    });
    await scheduler.tick();
    expect(submitPenalty).not.toHaveBeenCalled();

    const schedulerLater = new Scheduler({
      detector,
      responder,
      store,
      publicClient: makeResponderMockPublic().client,
      paymentChannelAddress: PAYMENT_CHANNEL,
      logger,
      windowMs: WINDOW_MS,
      thresholdRatio: 0.5,
      now: () => submitByMs + 1,
      closingProvider: () => [closing],
    });
    await schedulerLater.tick();
    expect(submitPenalty).toHaveBeenCalledTimes(1);
  });

  it('WTW-005 regression: remember() rejects forged signature and preserves prior evidence', async () => {
    handle = await startWatchtower({
      rpcUrl: 'http://127.0.0.1:1',
      privateKey: FAKE_PRIVATE_KEY,
      paymentChannelAddress: PAYMENT_CHANNEL,
      chainId: CHAIN_ID,
      publicClient: mockPublicClientForChannel(),
      startHttp: false,
    });

    const good = await buildSignedState(5n);
    await handle.remember(good);
    expect(handle.detector.getLatest(CHANNEL_ID)?.state.version).toBe(5n);

    const forged = await buildSignedState(6n, {}, { sigA: accountX });
    await expect(handle.remember(forged)).rejects.toThrow(/sigA does not verify/);
    expect(handle.detector.getLatest(CHANNEL_ID)?.state.version).toBe(5n);
  });

  it('WTW-005: remember() rejects state with non-empty htlcs', async () => {
    handle = await startWatchtower({
      rpcUrl: 'http://127.0.0.1:1',
      privateKey: FAKE_PRIVATE_KEY,
      paymentChannelAddress: PAYMENT_CHANNEL,
      chainId: CHAIN_ID,
      publicClient: mockPublicClientForChannel(),
      startHttp: false,
    });
    const withHtlc = await buildSignedState(2n, {
      htlcs: [
        {
          id: '0x000000000000000000000000000000000000000000000000000000000000beef',
          direction: 'AtoB',
          amount: 50n,
          paymentHash: '0x000000000000000000000000000000000000000000000000000000000000cafe',
          expiryMs: 99_999_999_999_999n,
        },
      ],
      balanceA: 50n,
      balanceB: 200n,
    });
    await expect(handle.remember(withHtlc)).rejects.toThrow(/non-empty HTLCs/);
  });

  it('WTW-005: remember() rejects state where balanceA + balanceB != totalFunding', async () => {
    handle = await startWatchtower({
      rpcUrl: 'http://127.0.0.1:1',
      privateKey: FAKE_PRIVATE_KEY,
      paymentChannelAddress: PAYMENT_CHANNEL,
      chainId: CHAIN_ID,
      publicClient: mockPublicClientForChannel(),
      startHttp: false,
    });
    const wrongTotal = await buildSignedState(2n, { balanceA: 999n, balanceB: 1n });
    await expect(handle.remember(wrongTotal)).rejects.toThrow(/balance not conserved/);
  });

  it('WTW-005: remember() rejects state with finalized=true', async () => {
    handle = await startWatchtower({
      rpcUrl: 'http://127.0.0.1:1',
      privateKey: FAKE_PRIVATE_KEY,
      paymentChannelAddress: PAYMENT_CHANNEL,
      chainId: CHAIN_ID,
      publicClient: mockPublicClientForChannel(),
      startHttp: false,
    });
    const finalized = await buildSignedState(2n, { finalized: true });
    await expect(handle.remember(finalized)).rejects.toThrow(/finalized; not penalty-capable/);
  });

  it('WTW-010: receipt with reverted status leaves observation unmarked and rejects', async () => {
    const pub = makeResponderMockPublic();
    const wallet = makeMockWallet();
    const txHash = `0x${'7e'.repeat(32)}` as Hash;
    wallet.writeContract.mockResolvedValueOnce(txHash);
    pub.waitForTransactionReceipt.mockResolvedValueOnce({
      status: 'reverted',
      transactionHash: txHash,
    });

    const responder = new PenaltyResponder({
      rpcUrl: 'http://localhost:0',
      privateKey: FAKE_PRIVATE_KEY,
      paymentChannelAddress: PAYMENT_CHANNEL,
      chainId: CHAIN_ID,
      logger,
      publicClient: pub.client,
      walletClient: wallet.client,
      store,
    });

    const obsId = store.recordObservation({
      channelId: CHANNEL_ID,
      postedVersion: 5n,
      postedAtMs: 0,
      ourLatestVersion: 10n,
      actionTaken: 'penalize',
      createdAtMs: 0,
    });
    const evidence = await buildSignedState(10n);
    await expect(responder.submitPenalty(CHANNEL_ID, evidence, 'A', obsId)).rejects.toThrow(
      /reverted on-chain/,
    );

    const row = db
      .prepare('SELECT included_at_ms FROM watchtower_observations WHERE id = ?')
      .get(obsId) as { included_at_ms: number | null };
    expect(row.included_at_ms).toBeNull();
  });
});
