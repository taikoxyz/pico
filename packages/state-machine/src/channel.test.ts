import type { ChannelState, Update } from '@tainnel/protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyUpdate, computeBalance, validateUpdate } from './channel.js';
import { BalanceMismatchError, StaleVersionError } from './errors.js';

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
