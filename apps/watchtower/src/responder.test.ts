import type { ChannelId, Hex, Signature, SignedState } from '@tainnel/protocol';
import type { PublicClient, WalletClient } from 'viem';
import { taiko } from 'viem/chains';
import { describe, expect, it, vi } from 'vitest';
import { logger } from './logger.js';
import {
  PenaltyResponder,
  PenaltySubmissionExhaustedError,
  PenaltySubmissionRevertedError,
  encodePenaltyState,
  packSignature,
} from './responder.js';

const channelId = '0x0000000000000000000000000000000000000000000000000000000000000abc' as ChannelId;
const contractAddress = '0x07B32f52523Fdf0780821595422DccEF31FA2335' as `0x${string}`;
// Throwaway test key (well-known anvil test account).
const privateKey = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' as Hex;

function evidence(version: bigint): SignedState {
  const sig: Signature = {
    r: `0x${'aa'.repeat(32)}` as Hex,
    s: `0x${'bb'.repeat(32)}` as Hex,
    v: 27,
  };
  return {
    state: {
      channelId,
      version,
      balanceA: 100n,
      balanceB: 200n,
      htlcs: [],
      finalized: false,
    },
    sigA: sig,
    sigB: sig,
  };
}

interface FakeChain {
  txHashSeq: number;
  sent: Array<{ to: string; data: Hex; gas?: bigint }>;
  receiptStatus: 'success' | 'reverted';
  receiptDelayMs: number;
  failOnAttempts: number;
  attempts: number;
  publicClient: PublicClient;
  walletClient: WalletClient;
}

function makeFakeChain(
  over: Partial<Pick<FakeChain, 'receiptStatus' | 'receiptDelayMs' | 'failOnAttempts'>> = {},
): FakeChain {
  const f: FakeChain = {
    txHashSeq: 0,
    sent: [],
    receiptStatus: over.receiptStatus ?? 'success',
    receiptDelayMs: over.receiptDelayMs ?? 0,
    failOnAttempts: over.failOnAttempts ?? 0,
    attempts: 0,
    publicClient: {
      estimateFeesPerGas: async () => ({
        maxFeePerGas: 1_000_000_000n,
        maxPriorityFeePerGas: 1_000_000n,
      }),
      estimateGas: async () => 250_000n,
      waitForTransactionReceipt: async ({ hash, timeout }: { hash: Hex; timeout: number }) => {
        if (f.receiptDelayMs > timeout) {
          throw new Error('timeout');
        }
        return { status: f.receiptStatus, transactionHash: hash };
      },
    } as unknown as PublicClient,
    walletClient: {
      sendTransaction: async (args: { to: string; data: Hex; gas?: bigint }) => {
        f.attempts += 1;
        if (f.attempts <= f.failOnAttempts) {
          throw new Error('mock send failure');
        }
        f.sent.push(args);
        const h = `0x${(++f.txHashSeq).toString(16).padStart(64, '0')}` as Hex;
        return h;
      },
    } as unknown as WalletClient,
  };
  return f;
}

describe('packSignature', () => {
  it('produces 65 bytes', () => {
    const s: Signature = {
      r: `0x${'aa'.repeat(32)}` as Hex,
      s: `0x${'bb'.repeat(32)}` as Hex,
      v: 27,
    };
    const packed = packSignature(s);
    expect(packed.length).toBe(2 + 65 * 2);
    expect(packed.endsWith('1b')).toBe(true);
  });
});

describe('encodePenaltyState', () => {
  it('encodes htlcsRoot=0 for empty htlcs', () => {
    const data = encodePenaltyState(evidence(7n));
    expect(data.startsWith('0x')).toBe(true);
    // 6 fields = 6 * 32 bytes = 192 bytes hex = 384 chars + 2 for '0x'
    expect(data.length).toBe(2 + 192 * 2);
  });
});

describe('PenaltyResponder.submitPenalty', () => {
  it('happy path returns txHash', async () => {
    const f = makeFakeChain();
    const r = new PenaltyResponder({
      rpcUrl: 'http://nope',
      chain: taiko,
      contractAddress,
      privateKey,
      logger,
      publicClient: f.publicClient,
      walletClient: f.walletClient,
    });
    const tx = await r.submitPenalty(channelId, evidence(10n), 'A');
    expect(tx.startsWith('0x')).toBe(true);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.to).toBe(contractAddress);
  });

  it('shares the in-flight promise across concurrent calls', async () => {
    const f = makeFakeChain();
    const r = new PenaltyResponder({
      rpcUrl: 'http://nope',
      chain: taiko,
      contractAddress,
      privateKey,
      logger,
      publicClient: f.publicClient,
      walletClient: f.walletClient,
    });
    const p1 = r.submitPenalty(channelId, evidence(10n), 'A');
    const p2 = r.submitPenalty(channelId, evidence(10n), 'A');
    expect(p1).toBe(p2);
    // resolve the (single) in-flight call cleanly so vitest doesn't see a leaked promise
    await p1;
    expect(f.attempts).toBe(1);
  });

  it('retries on send failure and eventually exhausts', async () => {
    const f = makeFakeChain({ failOnAttempts: 99 });
    const r = new PenaltyResponder({
      rpcUrl: 'http://nope',
      chain: taiko,
      contractAddress,
      privateKey,
      logger,
      publicClient: f.publicClient,
      walletClient: f.walletClient,
      maxAttempts: 3,
    });
    await expect(r.submitPenalty(channelId, evidence(10n), 'A')).rejects.toBeInstanceOf(
      PenaltySubmissionExhaustedError,
    );
    expect(f.attempts).toBe(3);
  });

  it('throws PenaltySubmissionRevertedError when receipt reverts', async () => {
    const f = makeFakeChain({ receiptStatus: 'reverted' });
    const r = new PenaltyResponder({
      rpcUrl: 'http://nope',
      chain: taiko,
      contractAddress,
      privateKey,
      logger,
      publicClient: f.publicClient,
      walletClient: f.walletClient,
    });
    await expect(r.submitPenalty(channelId, evidence(10n), 'A')).rejects.toBeInstanceOf(
      PenaltySubmissionRevertedError,
    );
  });
});
