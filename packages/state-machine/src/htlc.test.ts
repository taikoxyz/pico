import type { ChannelState, Htlc, PaymentHash, Preimage } from '@pico/protocol';
import fc from 'fast-check';
import { sha256 } from 'viem';
import { describe, expect, it } from 'vitest';
import { StateMachineError, UnknownHtlcError } from './errors.js';
import { addHtlc, expireHtlcs, failHtlc, settleHtlc } from './htlc.js';

const channelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as const;

const PREIMAGE: Preimage = '0x0000000000000000000000000000000000000000000000000000000000000001';
const PAYMENT_HASH = sha256(PREIMAGE) as PaymentHash;
const WRONG_PREIMAGE: Preimage =
  '0x000000000000000000000000000000000000000000000000000000000000beef';

function makeState(balanceA: bigint, balanceB: bigint, htlcs: readonly Htlc[] = []): ChannelState {
  return {
    channelId,
    version: 1n,
    balanceA,
    balanceB,
    htlcs,
    finalized: false,
  };
}

function htlcIdFor(idSuffix: string): `0x${string}` {
  return `0x${idSuffix.padStart(64, '0')}` as `0x${string}`;
}

function makeHtlc(
  idSuffix: string,
  amount: bigint,
  direction: 'AtoB' | 'BtoA' = 'AtoB',
  paymentHash: PaymentHash = PAYMENT_HASH,
  expiryMs = 1_800_000_000_000n,
): Htlc {
  return {
    id: htlcIdFor(idSuffix),
    direction,
    amount,
    paymentHash,
    expiryMs,
  };
}

describe('addHtlc', () => {
  it('AtoB: debits balanceA and appends', () => {
    const state = makeState(1000n, 2000n);
    const htlc = makeHtlc('1', 300n, 'AtoB');
    const next = addHtlc(state, htlc);
    expect(next.balanceA).toBe(700n);
    expect(next.balanceB).toBe(2000n);
    expect(next.htlcs).toEqual([htlc]);
  });

  it('BtoA: debits balanceB and appends', () => {
    const state = makeState(1000n, 2000n);
    const htlc = makeHtlc('1', 500n, 'BtoA');
    const next = addHtlc(state, htlc);
    expect(next.balanceA).toBe(1000n);
    expect(next.balanceB).toBe(1500n);
    expect(next.htlcs).toEqual([htlc]);
  });

  it('rejects zero amount', () => {
    expect(() => addHtlc(makeState(1000n, 0n), makeHtlc('1', 0n))).toThrow(StateMachineError);
    try {
      addHtlc(makeState(1000n, 0n), makeHtlc('1', 0n));
    } catch (err) {
      expect((err as StateMachineError).code).toBe('ZERO_AMOUNT');
    }
  });

  it('rejects duplicate ids', () => {
    const state = makeState(1000n, 1000n, [makeHtlc('1', 100n)]);
    try {
      addHtlc(state, makeHtlc('1', 200n));
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as StateMachineError).code).toBe('DUPLICATE_HTLC');
    }
  });

  it('AtoB rejects insufficient balance', () => {
    const state = makeState(100n, 1000n);
    try {
      addHtlc(state, makeHtlc('1', 200n, 'AtoB'));
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as StateMachineError).code).toBe('INSUFFICIENT_BALANCE');
    }
  });

  it('BtoA rejects insufficient balance', () => {
    const state = makeState(1000n, 50n);
    try {
      addHtlc(state, makeHtlc('1', 100n, 'BtoA'));
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as StateMachineError).code).toBe('INSUFFICIENT_BALANCE');
    }
  });

  it('preserves total balance + locked-htlc sum', () => {
    const state = makeState(1000n, 2000n);
    const htlc = makeHtlc('1', 300n, 'AtoB');
    const next = addHtlc(state, htlc);
    const totalBefore = state.balanceA + state.balanceB;
    const totalAfter =
      next.balanceA + next.balanceB + next.htlcs.reduce((s, h) => s + h.amount, 0n);
    expect(totalAfter).toBe(totalBefore);
  });
});

describe('settleHtlc', () => {
  it('AtoB: amount moves to receiver (B)', () => {
    const state = makeState(1000n, 2000n);
    const after = settleHtlc(addHtlc(state, makeHtlc('1', 300n, 'AtoB')), htlcIdFor('1'), PREIMAGE);
    expect(after.balanceA).toBe(700n);
    expect(after.balanceB).toBe(2300n);
    expect(after.htlcs).toEqual([]);
  });

  it('BtoA: amount moves to receiver (A)', () => {
    const state = makeState(1000n, 2000n);
    const after = settleHtlc(addHtlc(state, makeHtlc('1', 500n, 'BtoA')), htlcIdFor('1'), PREIMAGE);
    expect(after.balanceA).toBe(1500n);
    expect(after.balanceB).toBe(1500n);
    expect(after.htlcs).toEqual([]);
  });

  it('rejects unknown id', () => {
    const state = makeState(1000n, 1000n);
    expect(() => settleHtlc(state, htlcIdFor('99'), PREIMAGE)).toThrow(UnknownHtlcError);
  });

  it('rejects bad preimage', () => {
    const state = addHtlc(makeState(1000n, 1000n), makeHtlc('1', 100n));
    try {
      settleHtlc(state, htlcIdFor('1'), WRONG_PREIMAGE);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as StateMachineError).code).toBe('BAD_PREIMAGE');
    }
  });

  it('only removes the targeted htlc', () => {
    let state = makeState(1000n, 1000n);
    state = addHtlc(state, makeHtlc('1', 100n));
    state = addHtlc(state, makeHtlc('2', 200n));
    const after = settleHtlc(state, htlcIdFor('1'), PREIMAGE);
    expect(after.htlcs.map((h) => h.id)).toEqual([htlcIdFor('2')]);
  });
});

describe('failHtlc', () => {
  it('AtoB: amount returns to sender (A)', () => {
    const state = makeState(1000n, 2000n);
    const withHtlc = addHtlc(state, makeHtlc('1', 300n, 'AtoB'));
    const after = failHtlc(withHtlc, htlcIdFor('1'));
    expect(after.balanceA).toBe(1000n);
    expect(after.balanceB).toBe(2000n);
    expect(after.htlcs).toEqual([]);
  });

  it('BtoA: amount returns to sender (B)', () => {
    const state = makeState(1000n, 2000n);
    const withHtlc = addHtlc(state, makeHtlc('1', 500n, 'BtoA'));
    const after = failHtlc(withHtlc, htlcIdFor('1'));
    expect(after.balanceA).toBe(1000n);
    expect(after.balanceB).toBe(2000n);
    expect(after.htlcs).toEqual([]);
  });

  it('rejects unknown id', () => {
    expect(() => failHtlc(makeState(1n, 1n), htlcIdFor('99'))).toThrow(UnknownHtlcError);
  });
});

describe('expireHtlcs', () => {
  it('refunds expired htlcs to senders', () => {
    let state = makeState(1000n, 1000n);
    state = addHtlc(state, makeHtlc('1', 100n, 'AtoB', PAYMENT_HASH, 100n));
    state = addHtlc(state, makeHtlc('2', 200n, 'BtoA', PAYMENT_HASH, 200n));
    const after = expireHtlcs(state, 500n);
    expect(after.htlcs).toEqual([]);
    expect(after.balanceA).toBe(1000n);
    expect(after.balanceB).toBe(1000n);
  });

  it('leaves non-expired htlcs untouched', () => {
    let state = makeState(1000n, 1000n);
    state = addHtlc(state, makeHtlc('1', 100n, 'AtoB', PAYMENT_HASH, 100n));
    state = addHtlc(state, makeHtlc('2', 200n, 'BtoA', PAYMENT_HASH, 5_000_000_000_000n));
    const after = expireHtlcs(state, 500n);
    expect(after.htlcs.length).toBe(1);
    expect(after.htlcs[0]?.id).toBe(htlcIdFor('2'));
    // htlc1 (AtoB, 100, expired) refunds to A; htlc2 (BtoA, 200, not expired) stays locked off B.
    expect(after.balanceA).toBe(1000n);
    expect(after.balanceB).toBe(800n);
  });

  it('is idempotent: calling twice with the same nowMs yields the same state', () => {
    let state = makeState(1000n, 1000n);
    state = addHtlc(state, makeHtlc('1', 100n, 'AtoB', PAYMENT_HASH, 100n));
    state = addHtlc(state, makeHtlc('2', 200n, 'BtoA', PAYMENT_HASH, 200n));
    const once = expireHtlcs(state, 500n);
    const twice = expireHtlcs(once, 500n);
    expect(twice).toEqual(once);
  });

  it('does nothing when no htlcs are expired', () => {
    let state = makeState(1000n, 1000n);
    state = addHtlc(state, makeHtlc('1', 100n, 'AtoB', PAYMENT_HASH, 5_000_000_000_000n));
    const after = expireHtlcs(state, 500n);
    expect(after).toEqual(state);
  });
});

describe('htlc — properties (numRuns: 200)', () => {
  it('add → settle round-trip transfers exactly amount to receiver', () => {
    fc.assert(
      fc.property(
        fc.bigUintN(40).filter((n) => n > 0n),
        fc.bigUintN(40),
        fc.constantFrom('AtoB' as const, 'BtoA' as const),
        (amount, extra, direction) => {
          const balanceA = direction === 'AtoB' ? amount + extra : extra;
          const balanceB = direction === 'BtoA' ? amount + extra : extra;
          const state = makeState(balanceA, balanceB);
          const withHtlc = addHtlc(state, makeHtlc('1', amount, direction));
          const after = settleHtlc(withHtlc, htlcIdFor('1'), PREIMAGE);
          if (direction === 'AtoB') {
            return after.balanceA === balanceA - amount && after.balanceB === balanceB + amount;
          }
          return after.balanceA === balanceA + amount && after.balanceB === balanceB - amount;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('add → fail round-trip leaves balances unchanged', () => {
    fc.assert(
      fc.property(
        fc.bigUintN(40).filter((n) => n > 0n),
        fc.bigUintN(40),
        fc.constantFrom('AtoB' as const, 'BtoA' as const),
        (amount, extra, direction) => {
          const balanceA = direction === 'AtoB' ? amount + extra : extra;
          const balanceB = direction === 'BtoA' ? amount + extra : extra;
          const state = makeState(balanceA, balanceB);
          const withHtlc = addHtlc(state, makeHtlc('1', amount, direction));
          const after = failHtlc(withHtlc, htlcIdFor('1'));
          return (
            after.balanceA === balanceA && after.balanceB === balanceB && after.htlcs.length === 0
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it('expireHtlcs(now) is idempotent for any now', () => {
    fc.assert(
      fc.property(fc.bigUintN(64), (now) => {
        let state = makeState(10_000n, 10_000n);
        state = addHtlc(state, makeHtlc('1', 100n, 'AtoB', PAYMENT_HASH, 100n));
        state = addHtlc(state, makeHtlc('2', 200n, 'BtoA', PAYMENT_HASH, 1_000_000n));
        state = addHtlc(state, makeHtlc('3', 300n, 'AtoB', PAYMENT_HASH, 5_000_000_000_000n));
        const once = expireHtlcs(state, now);
        const twice = expireHtlcs(once, now);
        return JSON.stringify(twice, jsonReplacer) === JSON.stringify(once, jsonReplacer);
      }),
      { numRuns: 200 },
    );
  });
});

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
