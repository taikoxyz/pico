import type { ChannelState, Htlc, Update } from '@tainnel/protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyUpdate, computeBalance, validateUpdate } from './channel.js';
import { BalanceMismatchError, StaleVersionError, StateMachineError } from './errors.js';

const channelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as const;

function makeState(version: bigint, balanceA: bigint, balanceB: bigint): ChannelState {
  return {
    channelId,
    version,
    balanceA,
    balanceB,
    htlcs: [],
    finalized: false,
  };
}

describe('channel', () => {
  it('computeBalance returns the on-channel totals when no htlcs are pending', () => {
    const totals = computeBalance(makeState(1n, 100n, 50n));
    expect(totals).toEqual({ totalA: 100n, totalB: 50n });
  });

  it('rejects stale version updates', () => {
    const prev = makeState(5n, 100n, 50n);
    const update: Update = {
      channelId,
      fromVersion: 5n,
      toVersion: 5n,
      nextState: makeState(5n, 90n, 60n),
    };
    expect(() => validateUpdate(prev, update)).toThrow(StaleVersionError);
  });

  it('rejects updates that do not preserve total balance', () => {
    const prev = makeState(1n, 100n, 50n);
    const update: Update = {
      channelId,
      fromVersion: 1n,
      toVersion: 2n,
      nextState: makeState(2n, 100n, 60n),
    };
    expect(() => validateUpdate(prev, update)).toThrow(BalanceMismatchError);
  });

  it('rejects updates with a mismatched channel id', () => {
    const prev = makeState(1n, 100n, 50n);
    const update: Update = {
      channelId: '0x000000000000000000000000000000000000000000000000000000000000bbbb',
      fromVersion: 1n,
      toVersion: 2n,
      nextState: makeState(2n, 100n, 50n),
    };
    expect(() => validateUpdate(prev, update)).toThrow(/channel id/);
  });

  it('rejects updates against an already-finalized channel', () => {
    const prev: ChannelState = { ...makeState(1n, 100n, 50n), finalized: true };
    const update: Update = {
      channelId,
      fromVersion: 1n,
      toVersion: 2n,
      nextState: makeState(2n, 100n, 50n),
    };
    expect(() => validateUpdate(prev, update)).toThrow(/finalized/);
  });

  it('rejects flipping finalized: false → true while htlcs are pending', () => {
    const htlc: Htlc = {
      id: `0x${'01'.repeat(32)}`,
      direction: 'AtoB',
      amount: 10n,
      paymentHash: `0x${'02'.repeat(32)}`,
      expiryMs: 9_999_999n,
    };
    const prev: ChannelState = {
      ...makeState(1n, 90n, 50n),
      htlcs: [htlc],
    };
    const next: ChannelState = { ...prev, version: 2n, finalized: true };
    const update: Update = {
      channelId,
      fromVersion: 1n,
      toVersion: 2n,
      nextState: next,
    };
    expect(() => validateUpdate(prev, update)).toThrow(StateMachineError);
    expect(() => validateUpdate(prev, update)).toThrow(/cannot finalize/);
  });

  it('allows finalization with no pending htlcs', () => {
    const prev = makeState(1n, 100n, 50n);
    const next: ChannelState = { ...prev, version: 2n, finalized: true };
    const update: Update = {
      channelId,
      fromVersion: 1n,
      toVersion: 2n,
      nextState: next,
    };
    expect(applyUpdate(prev, update)).toEqual(next);
  });

  it('computeBalance accounts for pending htlcs on both sides', () => {
    const htlcAtoB: Htlc = {
      id: `0x${'01'.repeat(32)}`,
      direction: 'AtoB',
      amount: 30n,
      paymentHash: `0x${'00'.repeat(32)}`,
      expiryMs: 9_999_999n,
    };
    const htlcBtoA: Htlc = {
      id: `0x${'02'.repeat(32)}`,
      direction: 'BtoA',
      amount: 20n,
      paymentHash: `0x${'00'.repeat(32)}`,
      expiryMs: 9_999_999n,
    };
    const state: ChannelState = {
      ...makeState(1n, 70n, 30n),
      htlcs: [htlcAtoB, htlcBtoA],
    };
    expect(computeBalance(state)).toEqual({ totalA: 100n, totalB: 50n });
  });

  it('property: applyUpdate preserves total balance for any monotonic version bump', () => {
    fc.assert(
      fc.property(
        fc.bigUintN(64),
        fc.bigUintN(64),
        fc.bigUintN(32),
        fc.bigUintN(32),
        (a, b, fromV, bump) => {
          const total = a + b;
          const prev = makeState(fromV, a, b);
          const next = makeState(fromV + bump + 1n, b, a);
          const update: Update = {
            channelId,
            fromVersion: fromV,
            toVersion: fromV + bump + 1n,
            nextState: next,
          };
          const result = applyUpdate(prev, update);
          const totals = computeBalance(result);
          return totals.totalA + totals.totalB === total;
        },
      ),
      { numRuns: 100 },
    );
  });
});
