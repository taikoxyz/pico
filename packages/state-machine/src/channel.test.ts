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

  it('error codes are stable for each rejection path', () => {
    const prev = makeState(5n, 100n, 50n);
    try {
      validateUpdate(prev, {
        channelId: `0x${'aa'.repeat(32)}`,
        fromVersion: 5n,
        toVersion: 6n,
        nextState: makeState(6n, 100n, 50n),
      });
    } catch (err) {
      expect(err).toBeInstanceOf(StateMachineError);
      expect((err as StateMachineError).code).toBe('CHANNEL_ID_MISMATCH');
    }
    try {
      validateUpdate(
        { ...prev, finalized: true },
        { channelId, fromVersion: 5n, toVersion: 6n, nextState: makeState(6n, 100n, 50n) },
      );
    } catch (err) {
      expect((err as StateMachineError).code).toBe('FINALIZED');
    }
    try {
      validateUpdate(prev, {
        channelId,
        fromVersion: 5n,
        toVersion: 5n,
        nextState: makeState(5n, 100n, 50n),
      });
    } catch (err) {
      expect((err as StateMachineError).code).toBe('STALE_VERSION');
    }
    try {
      validateUpdate(prev, {
        channelId,
        fromVersion: 5n,
        toVersion: 6n,
        nextState: makeState(6n, 200n, 50n),
      });
    } catch (err) {
      expect((err as StateMachineError).code).toBe('BALANCE_MISMATCH');
    }
  });

  it('does not mutate the previous state when applying an update', () => {
    const prev = makeState(1n, 100n, 50n);
    const snapshot = {
      version: prev.version,
      balanceA: prev.balanceA,
      balanceB: prev.balanceB,
      htlcsLength: prev.htlcs.length,
      finalized: prev.finalized,
    };
    const update: Update = {
      channelId,
      fromVersion: 1n,
      toVersion: 2n,
      nextState: makeState(2n, 60n, 90n),
    };
    applyUpdate(prev, update);
    expect(prev.version).toBe(snapshot.version);
    expect(prev.balanceA).toBe(snapshot.balanceA);
    expect(prev.balanceB).toBe(snapshot.balanceB);
    expect(prev.htlcs.length).toBe(snapshot.htlcsLength);
    expect(prev.finalized).toBe(snapshot.finalized);
  });

  it('does not mutate the update.nextState reference when applying', () => {
    const next = makeState(2n, 60n, 90n);
    const snapshotBalanceA = next.balanceA;
    applyUpdate(makeState(1n, 100n, 50n), {
      channelId,
      fromVersion: 1n,
      toVersion: 2n,
      nextState: next,
    });
    expect(next.balanceA).toBe(snapshotBalanceA);
  });

  it('chains multiple updates that each preserve total balance', () => {
    const total = 150n;
    let cur = makeState(1n, 100n, 50n);
    const flips = [
      { a: 60n, b: 90n },
      { a: 75n, b: 75n },
      { a: 0n, b: 150n },
      { a: 150n, b: 0n },
    ];
    for (let i = 0; i < flips.length; i++) {
      const f = flips[i];
      if (!f) continue;
      const next = makeState(cur.version + 1n, f.a, f.b);
      cur = applyUpdate(cur, {
        channelId,
        fromVersion: cur.version,
        toVersion: cur.version + 1n,
        nextState: next,
      });
      expect(cur.balanceA + cur.balanceB).toBe(total);
    }
    expect(cur.version).toBe(5n);
  });

  it('accepts the smallest valid version bump (current + 1)', () => {
    const prev = makeState(0n, 100n, 50n);
    const next = makeState(1n, 100n, 50n);
    const update: Update = { channelId, fromVersion: 0n, toVersion: 1n, nextState: next };
    expect(applyUpdate(prev, update)).toEqual(next);
  });

  it('preserves total when transitioning into a state with htlcs', () => {
    const prev = makeState(1n, 100n, 50n);
    const htlc: Htlc = {
      id: `0x${'aa'.repeat(32)}`,
      direction: 'AtoB',
      amount: 25n,
      paymentHash: `0x${'bb'.repeat(32)}`,
      expiryMs: 9_999_999n,
    };
    const next: ChannelState = {
      ...prev,
      version: 2n,
      balanceA: 75n,
      htlcs: [htlc],
    };
    const result = applyUpdate(prev, {
      channelId,
      fromVersion: 1n,
      toVersion: 2n,
      nextState: next,
    });
    const totals = computeBalance(result);
    expect(totals.totalA + totals.totalB).toBe(150n);
  });

  it('preserves total when transitioning out of a state with htlcs', () => {
    const htlc: Htlc = {
      id: `0x${'cc'.repeat(32)}`,
      direction: 'AtoB',
      amount: 25n,
      paymentHash: `0x${'dd'.repeat(32)}`,
      expiryMs: 9_999_999n,
    };
    const prev: ChannelState = { ...makeState(1n, 75n, 50n), htlcs: [htlc] };
    const next = makeState(2n, 75n, 75n);
    const result = applyUpdate(prev, {
      channelId,
      fromVersion: 1n,
      toVersion: 2n,
      nextState: next,
    });
    expect(computeBalance(result)).toEqual({ totalA: 75n, totalB: 75n });
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
