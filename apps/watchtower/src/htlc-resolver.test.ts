import type { ChannelId, Hex, SignedState } from '@inferenceroom/pico-protocol';
import type { ChainAdapter } from '@inferenceroom/pico-sdk';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HtlcResolver } from './htlc-resolver.js';
import { logger } from './logger.js';
import { SqliteWatchtowerStore } from './storage.js';

const channelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as ChannelId;
const paymentHash = '0xabababababababababababababababababababababababababababababababab' as Hex;
const preimage = '0x1111111111111111111111111111111111111111111111111111111111111111' as Hex;
const htlcId = '0x0000000000000000000000000000000000000000000000000000000000000abc' as Hex;

function makeSignedState(htlcs: SignedState['state']['htlcs']): SignedState {
  let total = 0n;
  for (const h of htlcs) total += h.amount;
  return {
    state: {
      channelId,
      version: 1n,
      balanceA: 100n,
      balanceB: 100n,
      htlcs,
      htlcsCount: htlcs.length,
      htlcsTotalLocked: total,
      finalized: false,
    },
    sigA: { r: `0x${'00'.repeat(32)}`, s: `0x${'00'.repeat(32)}`, v: 27 },
    sigB: { r: `0x${'00'.repeat(32)}`, s: `0x${'00'.repeat(32)}`, v: 27 },
  };
}

function makeMockAdapter(): ChainAdapter & {
  claim: ReturnType<typeof vi.fn>;
  refund: ReturnType<typeof vi.fn>;
} {
  const claim = vi.fn(async () => ({ txHash: `0xabcd${'00'.repeat(30)}` as Hex }));
  const refund = vi.fn(async () => ({ txHash: `0xdcba${'00'.repeat(30)}` as Hex }));
  return {
    claim,
    refund,
    claimHtlc: claim,
    refundHtlc: refund,
    openChannel: vi.fn(),
    closeCooperative: vi.fn(),
    closeUnilateral: vi.fn(),
    closeUnilateralFromOpen: vi.fn(),
    topUp: vi.fn(),
    finalize: vi.fn(),
    waitForFinalized: vi.fn(),
  } as unknown as ChainAdapter & {
    claim: ReturnType<typeof vi.fn>;
    refund: ReturnType<typeof vi.fn>;
  };
}

describe('HtlcResolver', () => {
  let store: SqliteWatchtowerStore;

  beforeEach(() => {
    const db = new Database(':memory:');
    store = new SqliteWatchtowerStore(db);
    store.init();
  });

  it('claims when the preimage is known and the HTLC is not expired', async () => {
    const adapter = makeMockAdapter();
    const state = makeSignedState([
      {
        id: htlcId,
        direction: 'AtoB',
        amount: 50n,
        paymentHash,
        expiryMs: 9_999_999_999_999n,
      },
    ]);
    store.putSignedState(state);
    store.putPreimage({ paymentHash, preimage, learnedAtMs: 0 });

    const resolver = new HtlcResolver({ adapter, store, logger, nowMs: () => 1_000 });
    const outcome = await resolver.resolveChannel(channelId);

    expect(outcome.claimed).toEqual([htlcId]);
    expect(outcome.refunded).toEqual([]);
    expect(outcome.pending).toEqual([]);
    expect(outcome.errors.size).toBe(0);
    expect(adapter.claim).toHaveBeenCalledTimes(1);
    expect(adapter.refund).not.toHaveBeenCalled();
  });

  it('refunds when the HTLC has expired and no preimage is known', async () => {
    const adapter = makeMockAdapter();
    const state = makeSignedState([
      {
        id: htlcId,
        direction: 'AtoB',
        amount: 50n,
        paymentHash,
        expiryMs: 500n, // already in the past
      },
    ]);
    store.putSignedState(state);

    const resolver = new HtlcResolver({ adapter, store, logger, nowMs: () => 1_000 });
    const outcome = await resolver.resolveChannel(channelId);

    expect(outcome.claimed).toEqual([]);
    expect(outcome.refunded).toEqual([htlcId]);
    expect(adapter.refund).toHaveBeenCalledTimes(1);
  });

  it('falls back to refund once the channel-wide resolution deadline passes (H1)', async () => {
    const adapter = makeMockAdapter();
    const state = makeSignedState([
      {
        id: htlcId,
        direction: 'AtoB',
        amount: 50n,
        paymentHash,
        // Far-future expiry — without the resolution-deadline path this would
        // deadlock the channel because neither claim nor refund would be
        // admissible inside the window.
        expiryMs: 99_999_999_999_999n,
      },
    ]);
    store.putSignedState(state);

    const resolver = new HtlcResolver({ adapter, store, logger, nowMs: () => 2_000 });
    const outcome = await resolver.resolveChannel(channelId, {
      channelResolutionDeadlineMs: 1_500,
    });

    expect(outcome.refunded).toEqual([htlcId]);
    expect(adapter.refund).toHaveBeenCalledTimes(1);
  });

  it('leaves an unexpired HTLC with no preimage in pending', async () => {
    const adapter = makeMockAdapter();
    const state = makeSignedState([
      {
        id: htlcId,
        direction: 'AtoB',
        amount: 50n,
        paymentHash,
        expiryMs: 9_999_999_999_999n,
      },
    ]);
    store.putSignedState(state);

    const resolver = new HtlcResolver({ adapter, store, logger, nowMs: () => 1_000 });
    const outcome = await resolver.resolveChannel(channelId);

    expect(outcome.pending).toEqual([htlcId]);
    expect(adapter.claim).not.toHaveBeenCalled();
    expect(adapter.refund).not.toHaveBeenCalled();
  });

  it('rememberPreimage persists into the store', () => {
    const adapter = makeMockAdapter();
    const resolver = new HtlcResolver({ adapter, store, logger, nowMs: () => 12_345 });
    resolver.rememberPreimage(paymentHash, preimage);
    const got = store.getPreimage(paymentHash);
    expect(got?.preimage).toBe(preimage);
    expect(got?.learnedAtMs).toBe(12_345);
  });
});
