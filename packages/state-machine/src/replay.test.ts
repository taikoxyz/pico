import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { StaleVersionError } from './errors.js';
import { ensureMonotonicVersion, isStrictlyNewer } from './replay.js';

describe('replay — version monotonicity', () => {
  it('accepts strictly increasing versions', () => {
    expect(() => ensureMonotonicVersion(0n, 1n)).not.toThrow();
    expect(() => ensureMonotonicVersion(5n, 6n)).not.toThrow();
  });

  it('rejects equal versions', () => {
    expect(() => ensureMonotonicVersion(7n, 7n)).toThrow(StaleVersionError);
  });

  it('rejects smaller versions', () => {
    expect(() => ensureMonotonicVersion(7n, 6n)).toThrow(StaleVersionError);
  });

  it('rejects zero when current is non-zero', () => {
    expect(() => ensureMonotonicVersion(3n, 0n)).toThrow(StaleVersionError);
  });

  it('property: rejects any next ≤ current', () => {
    fc.assert(
      fc.property(fc.bigUintN(64), fc.bigUintN(64), (current, delta) => {
        const next = current >= delta ? current - delta : 0n;
        try {
          ensureMonotonicVersion(current, next);
          return next > current;
        } catch (err) {
          return err instanceof StaleVersionError && next <= current;
        }
      }),
      { numRuns: 200 },
    );
  });

  it('property: accepts any strictly increasing pair', () => {
    fc.assert(
      fc.property(fc.bigUintN(63), fc.bigUintN(32), (current, bump) => {
        const next = current + bump + 1n;
        ensureMonotonicVersion(current, next);
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it('isStrictlyNewer agrees with bigint compare', () => {
    fc.assert(
      fc.property(fc.bigUintN(64), fc.bigUintN(64), (a, b) => {
        return isStrictlyNewer({ version: a }, { version: b }) === a > b;
      }),
      { numRuns: 200 },
    );
  });
});
