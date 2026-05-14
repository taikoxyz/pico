/**
 * R-05: a successfully-included penalty tx whose block is reorg'd out is
 * re-evaluated and re-submitted.
 *
 * This test verifies two things:
 * 1. The store correctly records block_hash/block_number on inclusion and
 *    rewindForReorg clears that state.
 * 2. After the rewind, a subsequent submitPenalty call succeeds (fresh path),
 *    demonstrating the watchtower can re-submit the penalty.
 */
import type { Address, ChannelId, Hex, SignedState } from '@inferenceroom/pico-protocol';
import Database from 'better-sqlite3';
import type { Hash, PublicClient, WalletClient } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from './logger.js';
import { PenaltyResponder } from './responder.js';
import { SqliteWatchtowerStore } from './storage.js';

const channelId = `0x${'00'.repeat(31)}01` as ChannelId;
const paymentChannel = '0x000000000000000000000000000000000000dead' as Address;
const fakePrivateKey = `0x${'11'.repeat(32)}` as Hex;
const account = {
  address: '0x000000000000000000000000000000000000beef' as Address,
  type: 'local' as const,
};

const INCLUSION_BLOCK_HASH = `0x${'cc'.repeat(32)}` as `0x${string}`;
const INCLUSION_BLOCK_NUMBER = 500n;

function makeEvidence(version: bigint): SignedState {
  return {
    state: {
      channelId,
      version,
      balanceA: 100n,
      balanceB: 200n,
      htlcs: [],
      htlcsCount: 0,
      htlcsTotalLocked: 0n,
      finalized: false,
    },
    sigA: { r: `0x${'aa'.repeat(32)}`, s: `0x${'bb'.repeat(32)}`, v: 27 },
    sigB: { r: `0x${'cc'.repeat(32)}`, s: `0x${'dd'.repeat(32)}`, v: 28 },
  };
}

describe('PenaltyResponder reorg handling (R-05)', () => {
  let db: Database.Database;
  let store: SqliteWatchtowerStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SqliteWatchtowerStore(db);
    store.init();
  });

  afterEach(() => {
    store.close();
    if (db.open) db.close();
  });

  it('stores block_hash and block_number on inclusion, rewindForReorg clears them, and re-submission succeeds', async () => {
    const txHash = `0x${'aa'.repeat(32)}` as Hash;
    const newTxHash = `0x${'bb'.repeat(32)}` as Hash;

    const getTransactionReceipt = vi.fn().mockResolvedValue(null);
    const writeContract = vi.fn().mockResolvedValueOnce(txHash).mockResolvedValueOnce(newTxHash);
    const waitForTransactionReceipt = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'success',
        transactionHash: txHash,
        blockHash: INCLUSION_BLOCK_HASH,
        blockNumber: INCLUSION_BLOCK_NUMBER,
      })
      .mockResolvedValueOnce({
        status: 'success',
        transactionHash: newTxHash,
        blockHash: `0x${'dd'.repeat(32)}`,
        blockNumber: INCLUSION_BLOCK_NUMBER + 1n,
      });

    const publicClient = {
      getTransactionReceipt,
      waitForTransactionReceipt,
      estimateFeesPerGas: vi
        .fn()
        .mockResolvedValue({ maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 100_000_000n }),
      estimateContractGas: vi.fn().mockResolvedValue(250_000n),
      getTransactionCount: vi.fn().mockResolvedValue(7),
    } as unknown as PublicClient;

    const walletClient = {
      account,
      chain: undefined,
      writeContract,
    } as unknown as WalletClient;

    const responder = new PenaltyResponder({
      rpcUrl: 'http://localhost:8545',
      privateKey: fakePrivateKey,
      paymentChannelAddress: paymentChannel,
      chainId: 31337,
      logger,
      publicClient,
      walletClient,
      store,
    });

    // Record an observation so block_hash/block_number are stored.
    const obsId = store.recordObservation({
      channelId,
      postedVersion: 1n,
      postedAtMs: 1_000,
      ourLatestVersion: 5n,
      actionTaken: 'penalize',
      createdAtMs: 1_000,
    });

    // First submission — the tx gets included in INCLUSION_BLOCK_NUMBER.
    const firstHash = await responder.submitPenalty(channelId, makeEvidence(5n), 'A', obsId);
    expect(firstHash).toBe(txHash);
    expect(store.getInFlight(channelId)).toBeUndefined();

    // Verify the block_hash and block_number were persisted.
    const row = db
      .prepare(
        'SELECT block_hash, block_number, included_at_ms FROM watchtower_observations WHERE id = ?',
      )
      .get(obsId) as {
      block_hash: string | null;
      block_number: number | null;
      included_at_ms: number | null;
    };
    expect(row.block_hash).toBe(INCLUSION_BLOCK_HASH);
    expect(row.block_number).toBe(Number(INCLUSION_BLOCK_NUMBER));
    expect(row.included_at_ms).not.toBeNull();

    // Simulate a reorg: the inclusion block (500) is orphaned.
    const affected = store.rewindForReorg(INCLUSION_BLOCK_NUMBER);
    expect(affected).toContain(channelId);

    // The observation's inclusion state must be cleared.
    const afterRewind = db
      .prepare(
        'SELECT block_hash, block_number, included_at_ms FROM watchtower_observations WHERE id = ?',
      )
      .get(obsId) as {
      block_hash: string | null;
      block_number: number | null;
      included_at_ms: number | null;
    };
    expect(afterRewind.block_hash).toBeNull();
    expect(afterRewind.block_number).toBeNull();
    expect(afterRewind.included_at_ms).toBeNull();

    // Re-submission: after the reorg, the penalty can be re-submitted.
    // (Caller is responsible for calling submitPenalty again after detecting
    // the reorg via rewindForReorg returning the affected channelIds.)
    const obsId2 = store.recordObservation({
      channelId,
      postedVersion: 1n,
      postedAtMs: 1_000,
      ourLatestVersion: 5n,
      actionTaken: 'penalize',
      createdAtMs: 2_000,
    });
    const secondHash = await responder.submitPenalty(channelId, makeEvidence(5n), 'A', obsId2);
    expect(secondHash).toBe(newTxHash);
    expect(store.getInFlight(channelId)).toBeUndefined();
  });

  it('rewindForReorg only affects blocks at or after fromBlock', () => {
    const obsId1 = store.recordObservation({
      channelId,
      postedVersion: 1n,
      postedAtMs: 1_000,
      ourLatestVersion: 5n,
      actionTaken: 'penalize',
      createdAtMs: 1_000,
    });
    const obsId2 = store.recordObservation({
      channelId: `0x${'00'.repeat(31)}02` as ChannelId,
      postedVersion: 1n,
      postedAtMs: 1_000,
      ourLatestVersion: 5n,
      actionTaken: 'penalize',
      createdAtMs: 1_000,
    });

    store.markObservationIncluded(obsId1, 1_000, `0x${'aa'.repeat(32)}` as `0x${string}`, 100n);
    store.markObservationIncluded(obsId2, 1_000, `0x${'bb'.repeat(32)}` as `0x${string}`, 200n);

    // Rewind from block 150: obsId2 (block 200) is affected, obsId1 (block 100) is not.
    const affected = store.rewindForReorg(150n);
    expect(affected).toHaveLength(1);

    const row1 = db
      .prepare('SELECT included_at_ms FROM watchtower_observations WHERE id = ?')
      .get(obsId1) as { included_at_ms: number | null };
    expect(row1.included_at_ms).not.toBeNull();

    const row2 = db
      .prepare('SELECT included_at_ms FROM watchtower_observations WHERE id = ?')
      .get(obsId2) as { included_at_ms: number | null };
    expect(row2.included_at_ms).toBeNull();
  });
});
