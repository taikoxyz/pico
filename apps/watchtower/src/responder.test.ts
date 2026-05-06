import type { Address, ChannelId, Hex, SignedState } from '@inferenceroom/pico-protocol';
import Database from 'better-sqlite3';
import type { Hash, PublicClient, WalletClient } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from './logger.js';
import { penaltiesSubmittedTotal } from './metrics.js';
import { PenaltyResponder } from './responder.js';
import { SqliteWatchtowerStore } from './storage.js';

const channelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as ChannelId;
const paymentChannel = '0x000000000000000000000000000000000000dead' as Address;
const account = {
  address: '0x000000000000000000000000000000000000beef' as Address,
  type: 'local' as const,
};
const fakePrivateKey = `0x${'11'.repeat(32)}` as Hex;

function makeEvidence(version: bigint): SignedState {
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
  getTransactionReceipt: ReturnType<typeof vi.fn>;
  waitForTransactionReceipt: ReturnType<typeof vi.fn>;
  estimateFeesPerGas: ReturnType<typeof vi.fn>;
  estimateContractGas: ReturnType<typeof vi.fn>;
  getTransactionCount: ReturnType<typeof vi.fn>;
}

interface MockWallet {
  client: WalletClient;
  writeContract: ReturnType<typeof vi.fn>;
}

function makeMockPublic(): MockPublic {
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

function makeMockWallet(): MockWallet {
  const writeContract = vi.fn();
  const client = {
    account,
    chain: undefined,
    writeContract,
  } as unknown as WalletClient;
  return { client, writeContract };
}

describe('PenaltyResponder', () => {
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

  it('A: fresh path submits, includes, and clears in-flight', async () => {
    const pub = makeMockPublic();
    const wallet = makeMockWallet();
    const txHash = `0x${'aa'.repeat(32)}` as Hash;
    wallet.writeContract.mockResolvedValueOnce(txHash);
    pub.waitForTransactionReceipt.mockResolvedValueOnce({
      status: 'success',
      transactionHash: txHash,
    });

    const before = await readCounter();
    const responder = new PenaltyResponder({
      rpcUrl: 'http://localhost:0',
      privateKey: fakePrivateKey,
      paymentChannelAddress: paymentChannel,
      chainId: 31337,
      logger,
      publicClient: pub.client,
      walletClient: wallet.client,
      store,
    });

    const result = await responder.submitPenalty(channelId, makeEvidence(10n), 'A');

    expect(result).toBe(txHash);
    expect(wallet.writeContract).toHaveBeenCalledTimes(1);
    expect(store.getInFlight(channelId)).toBeUndefined();
    const after = await readCounter();
    expect(after - before).toBe(1);
  });

  it('B: idempotent no-op when an in-flight tx is still pending', async () => {
    const pub = makeMockPublic();
    const wallet = makeMockWallet();
    const existingHash = `0x${'be'.repeat(32)}` as Hash;

    store.putInFlight({
      channelId,
      txHash: existingHash,
      // Recent submittedAtMs so it stays within the inclusion timeout and the
      // idempotent no-op path runs (instead of replacement).
      submittedAtMs: Date.now(),
      nonce: 7,
      maxFeePerGas: 1_000_000_000n,
      attempts: 1,
    });

    pub.getTransactionReceipt.mockResolvedValueOnce(null);

    const responder = new PenaltyResponder({
      rpcUrl: 'http://localhost:0',
      privateKey: fakePrivateKey,
      paymentChannelAddress: paymentChannel,
      chainId: 31337,
      logger,
      publicClient: pub.client,
      walletClient: wallet.client,
      store,
      inclusionTimeoutMs: 60_000,
    });

    const result = await responder.submitPenalty(channelId, makeEvidence(10n), 'A');
    expect(result).toBe(existingHash);
    expect(wallet.writeContract).not.toHaveBeenCalled();
    expect(store.getInFlight(channelId)?.txHash).toBe(existingHash);
  });

  it('C: gas-bump retry — first wait times out, second attempt succeeds with same nonce and bumped fees', async () => {
    vi.useFakeTimers();
    const pub = makeMockPublic();
    const wallet = makeMockWallet();
    const firstHash = `0x${'11'.repeat(32)}` as Hash;
    const secondHash = `0x${'22'.repeat(32)}` as Hash;
    wallet.writeContract.mockResolvedValueOnce(firstHash).mockResolvedValueOnce(secondHash);

    pub.waitForTransactionReceipt
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timeout')), 60_000)),
      )
      .mockResolvedValueOnce({ status: 'success', transactionHash: secondHash });

    const responder = new PenaltyResponder({
      rpcUrl: 'http://localhost:0',
      privateKey: fakePrivateKey,
      paymentChannelAddress: paymentChannel,
      chainId: 31337,
      logger,
      publicClient: pub.client,
      walletClient: wallet.client,
      store,
      inclusionTimeoutMs: 60_000,
      gasBumpPercent: 25,
      maxAttempts: 4,
    });

    const promise = responder.submitPenalty(channelId, makeEvidence(10n), 'A');
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;

    expect(result).toBe(secondHash);
    expect(wallet.writeContract).toHaveBeenCalledTimes(2);
    const firstArgs = wallet.writeContract.mock.calls[0]?.[0] as {
      nonce: number;
      maxFeePerGas: bigint;
      maxPriorityFeePerGas: bigint;
    };
    const secondArgs = wallet.writeContract.mock.calls[1]?.[0] as {
      nonce: number;
      maxFeePerGas: bigint;
      maxPriorityFeePerGas: bigint;
    };
    expect(firstArgs.nonce).toBe(7);
    expect(secondArgs.nonce).toBe(7);
    expect(firstArgs.maxFeePerGas).toBe(1_000_000_000n);
    expect(secondArgs.maxFeePerGas).toBe((1_000_000_000n * 125n) / 100n);
    expect(secondArgs.maxPriorityFeePerGas).toBe((100_000_000n * 125n) / 100n);
    expect(store.getInFlight(channelId)).toBeUndefined();
  });

  it('D: stale revert clears in-flight and re-throws', async () => {
    const pub = makeMockPublic();
    const wallet = makeMockWallet();
    wallet.writeContract.mockRejectedValueOnce(new Error('stale: posted version >= our version'));

    const responder = new PenaltyResponder({
      rpcUrl: 'http://localhost:0',
      privateKey: fakePrivateKey,
      paymentChannelAddress: paymentChannel,
      chainId: 31337,
      logger,
      publicClient: pub.client,
      walletClient: wallet.client,
      store,
    });

    await expect(responder.submitPenalty(channelId, makeEvidence(10n), 'A')).rejects.toThrow(
      /stale/i,
    );
    expect(store.getInFlight(channelId)).toBeUndefined();
  });

  it('E: marks the in-flight rows observationId as included, not the current calls', async () => {
    const pub = makeMockPublic();
    const wallet = makeMockWallet();
    const existingHash = `0x${'ee'.repeat(32)}` as Hash;

    const originalObsId = store.recordObservation({
      channelId,
      postedVersion: 5n,
      postedAtMs: 1_000,
      ourLatestVersion: 10n,
      actionTaken: 'penalize',
      createdAtMs: 1_500,
    });
    store.markObservationSubmitted(originalObsId, existingHash, 2_000);
    store.putInFlight({
      channelId,
      txHash: existingHash,
      submittedAtMs: 2_000,
      nonce: 7,
      maxFeePerGas: 1_000_000_000n,
      attempts: 1,
      observationId: originalObsId,
    });

    pub.getTransactionReceipt.mockResolvedValueOnce({
      status: 'success',
      transactionHash: existingHash,
    });

    const responder = new PenaltyResponder({
      rpcUrl: 'http://localhost:0',
      privateKey: fakePrivateKey,
      paymentChannelAddress: paymentChannel,
      chainId: 31337,
      logger,
      publicClient: pub.client,
      walletClient: wallet.client,
      store,
    });

    const callerObsId = store.recordObservation({
      channelId,
      postedVersion: 5n,
      postedAtMs: 1_000,
      ourLatestVersion: 10n,
      actionTaken: 'penalize',
      createdAtMs: 9_000,
    });

    const result = await responder.submitPenalty(channelId, makeEvidence(10n), 'A', callerObsId);
    expect(result).toBe(existingHash);
    expect(wallet.writeContract).not.toHaveBeenCalled();
    expect(store.getInFlight(channelId)).toBeUndefined();

    const original = db
      .prepare('SELECT included_at_ms FROM watchtower_observations WHERE id = ?')
      .get(originalObsId) as { included_at_ms: number | null };
    const caller = db
      .prepare('SELECT included_at_ms FROM watchtower_observations WHERE id = ?')
      .get(callerObsId) as { included_at_ms: number | null };
    expect(original.included_at_ms).not.toBeNull();
    expect(caller.included_at_ms).toBeNull();
  });
});

async function readCounter(): Promise<number> {
  const metrics = await penaltiesSubmittedTotal.get();
  const value = metrics.values[0]?.value;
  return typeof value === 'number' ? value : 0;
}
