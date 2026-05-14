/**
 * R-04: two concurrent submitPenalty calls on different channels must serialize
 * on the wallet and must NOT use the same nonce.
 */
import type { Address, ChannelId, Hex, SignedState } from '@inferenceroom/pico-protocol';
import type { Hash, PublicClient, WalletClient } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { logger } from './logger.js';
import { PenaltyResponder } from './responder.js';

const paymentChannel = '0x000000000000000000000000000000000000dead' as Address;
const account = {
  address: '0x000000000000000000000000000000000000beef' as Address,
  type: 'local' as const,
};

function makeEvidence(channelId: ChannelId, version: bigint): SignedState {
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

describe('PenaltyResponder concurrent nonce (R-04)', () => {
  it('two concurrent submitPenalty calls use distinct nonces', async () => {
    const channelA = `0x${'00'.repeat(31)}aa` as ChannelId;
    const channelB = `0x${'00'.repeat(31)}bb` as ChannelId;

    // Nonce counter: the mock always returns the current counter value and
    // increments it. Under the mutex the two calls are serialized, so they
    // should receive nonce=0 and nonce=1 respectively. Without the mutex they
    // would both race and could receive the same nonce.
    let nonceCounter = 0;
    const noncesUsed: number[] = [];

    const getTransactionCount = vi.fn(() => {
      const n = nonceCounter++;
      return Promise.resolve(n);
    });

    const writeContract = vi.fn((args: { nonce: number }) => {
      noncesUsed.push(args.nonce);
      return Promise.resolve(`0x${'ff'.repeat(32)}` as Hash);
    });

    const waitForTransactionReceipt = vi.fn().mockResolvedValue({
      status: 'success',
      blockHash: `0x${'ab'.repeat(32)}` as Hash,
      blockNumber: 1n,
    });

    const publicClient = {
      getTransactionReceipt: vi.fn().mockResolvedValue(null),
      waitForTransactionReceipt,
      estimateFeesPerGas: vi
        .fn()
        .mockResolvedValue({ maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 100_000_000n }),
      estimateContractGas: vi.fn().mockResolvedValue(250_000n),
      getTransactionCount,
    } as unknown as PublicClient;

    const walletClient = {
      account,
      chain: undefined,
      writeContract,
    } as unknown as WalletClient;

    const responder = new PenaltyResponder({
      rpcUrl: 'http://localhost:8545',
      privateKey: `0x${'11'.repeat(32)}` as Hex,
      paymentChannelAddress: paymentChannel,
      chainId: 31337,
      logger,
      publicClient,
      walletClient,
    });

    // Fire both concurrently without awaiting individually.
    const [hashA, hashB] = await Promise.all([
      responder.submitPenalty(channelA, makeEvidence(channelA, 2n), 'A'),
      responder.submitPenalty(channelB, makeEvidence(channelB, 2n), 'B'),
    ]);

    expect(hashA).toBeDefined();
    expect(hashB).toBeDefined();

    // Each channel must have used a distinct nonce.
    expect(noncesUsed).toHaveLength(2);
    expect(noncesUsed[0]).not.toBe(noncesUsed[1]);
  });
});
