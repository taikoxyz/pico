import type { ChannelState, Htlc, Update } from '@inferenceroom/pico-protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyUpdate, computeBalance, validateUpdate } from './channel.js';
import { BalanceMismatchError, StaleVersionError, type StateMachineError } from './errors.js';

const channelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as const;
const otherChannelId =
  '0x0000000000000000000000000000000000000000000000000000000000000002' as const;

function makeState(
  version: bigint,
  balanceA: bigint,
  balanceB: bigint,
  htlcs: readonly Htlc[] = [],
  finalized = false,
): ChannelState {
  let htlcsTotalLocked = 0n;
  for (const h of htlcs) htlcsTotalLocked += h.amount;
  return {
    channelId,
    version,
    balanceA,
    balanceB,
    htlcs,
    htlcsCount: htlcs.length,
    htlcsTotalLocked,
    finalized,
  };
}

function makeHtlc(idSuffix: string, amount: bigint, direction: 'AtoB' | 'BtoA' = 'AtoB'): Htlc {
  return {
    id: `0x${idSuffix.padStart(64, '0')}` as const,
    direction,
    amount,
    paymentHash: '0xabababababababababababababababababababababababababababababababab' as const,
    expiryMs: 1_800_000_000_000n,
  };
}

describe('channel', () => {
  it('computeBalance returns the on-channel totals when no htlcs are pending', () => {
    const totals = computeBalance(makeState(1n, 100n, 50n));
    expect(totals).toEqual({ totalA: 100n, totalB: 50n });
  });

  it('computeBalance adds locked AtoB amounts back to totalA', () => {
    const state = makeState(1n, 90n, 50n, [makeHtlc('1', 10n, 'AtoB')]);
    const totals = computeBalance(state);
    expect(totals).toEqual({ totalA: 100n, totalB: 50n });
  });

  it('computeBalance adds locked BtoA amounts back to totalB', () => {
    const state = makeState(1n, 100n, 30n, [makeHtlc('1', 20n, 'BtoA')]);
    const totals = computeBalance(state);
    expect(totals).toEqual({ totalA: 100n, totalB: 50n });
  });

  it('computeBalance handles a mix of directions', () => {
    const state = makeState(1n, 80n, 70n, [makeHtlc('1', 20n, 'AtoB'), makeHtlc('2', 30n, 'BtoA')]);
    expect(computeBalance(state)).toEqual({ totalA: 100n, totalB: 100n });
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
      { numRuns: 200 },
    );
  });

  it('rejects channelId mismatch', () => {
    const prev = makeState(1n, 100n, 100n);
    const update: Update = {
      channelId: otherChannelId,
      fromVersion: 1n,
      toVersion: 2n,
      nextState: { ...makeState(2n, 100n, 100n), channelId: otherChannelId },
    };
    try {
      validateUpdate(prev, update);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as StateMachineError).code).toBe('CHANNEL_ID_MISMATCH');
    }
  });

  it('rejects fromVersion mismatch', () => {
    const prev = makeState(5n, 100n, 100n);
    const update: Update = {
      channelId,
      fromVersion: 4n,
      toVersion: 6n,
      nextState: makeState(6n, 100n, 100n),
    };
    try {
      validateUpdate(prev, update);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as StateMachineError).code).toBe('FROM_VERSION_MISMATCH');
    }
  });

  it('rejects updates against an already-finalized channel', () => {
    const prev = makeState(5n, 100n, 100n, [], true);
    const update: Update = {
      channelId,
      fromVersion: 5n,
      toVersion: 6n,
      nextState: makeState(6n, 100n, 100n),
    };
    try {
      validateUpdate(prev, update);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as StateMachineError).code).toBe('FINALIZED');
    }
  });

  it('rejects nextState.version != toVersion', () => {
    const prev = makeState(1n, 100n, 100n);
    const update: Update = {
      channelId,
      fromVersion: 1n,
      toVersion: 2n,
      nextState: makeState(3n, 100n, 100n),
    };
    try {
      validateUpdate(prev, update);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as StateMachineError).code).toBe('VERSION_MISMATCH');
    }
  });

  it('rejects finalize-with-pending-htlcs', () => {
    const prev = makeState(1n, 100n, 100n);
    const update: Update = {
      channelId,
      fromVersion: 1n,
      toVersion: 2n,
      nextState: makeState(2n, 100n, 100n, [makeHtlc('1', 50n)], true),
    };
    try {
      validateUpdate(prev, update);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as StateMachineError).code).toBe('PENDING_HTLCS');
    }
  });

  it('allows cooperative finalize with no pending htlcs', () => {
    const prev = makeState(1n, 100n, 100n);
    const update: Update = {
      channelId,
      fromVersion: 1n,
      toVersion: 2n,
      nextState: makeState(2n, 100n, 100n, [], true),
    };
    expect(() => validateUpdate(prev, update)).not.toThrow();
    const result = applyUpdate(prev, update);
    expect(result.finalized).toBe(true);
    expect(result.htlcs).toEqual([]);
  });

  it('property: total balance + locked-htlc-sum is conserved across any valid update', () => {
    fc.assert(
      fc.property(
        fc.bigUintN(40),
        fc.bigUintN(40),
        fc.bigUintN(40).filter((n) => n > 0n),
        fc.bigUintN(32),
        (a, b, htlcAmount, bump) => {
          // start state has the HTLC already locked off A; new state moves it to B (settle).
          if (a < htlcAmount) return true;
          const htlc = makeHtlc('1', htlcAmount, 'AtoB');
          const prev = makeState(1n, a - htlcAmount, b, [htlc]);
          const next = makeState(1n + bump + 1n, a - htlcAmount, b + htlcAmount);
          const update: Update = {
            channelId,
            fromVersion: 1n,
            toVersion: 1n + bump + 1n,
            nextState: next,
          };
          const result = applyUpdate(prev, update);
          const before =
            prev.balanceA + prev.balanceB + prev.htlcs.reduce((s, h) => s + h.amount, 0n);
          const after =
            result.balanceA + result.balanceB + result.htlcs.reduce((s, h) => s + h.amount, 0n);
          return after === before;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('M5: rejects update whose htlcsTotalLocked-derived pot does not conserve', () => {
    // Construct a malicious "next" state whose `htlcsTotalLocked` is inflated
    // without touching balances. The computeBalance path would still match
    // (it derives from `htlcs`), but the derived-field check using
    // htlcsTotalLocked directly should catch the divergence.
    const prev = makeState(1n, 50n, 50n);
    const malicious: ChannelState = {
      ...makeState(2n, 50n, 50n),
      // Lie about the locked total — admitSignedState would catch this via
      // M4 (htlcsTotalLocked != Σ amount), but validateUpdate's M5 guard
      // catches the cross-state divergence too.
      htlcsTotalLocked: 25n,
    };
    const update: Update = {
      channelId,
      fromVersion: 1n,
      toVersion: 2n,
      nextState: malicious,
    };
    expect(() => validateUpdate(prev, update)).toThrow(BalanceMismatchError);
  });
});
