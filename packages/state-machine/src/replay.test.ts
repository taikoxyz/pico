import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { StaleVersionError } from './errors.js';
import { ensureMonotonicVersion, isStrictlyNewer } from './replay.js';

describe('ensureMonotonicVersion', () => {
  it('accepts a strictly greater version', () => {
    expect(() => ensureMonotonicVersion(0n, 1n)).not.toThrow();
    expect(() => ensureMonotonicVersion(5n, 6n)).not.toThrow();
    expect(() => ensureMonotonicVersion(0n, 1_000_000_000n)).not.toThrow();
  });

  it('throws StaleVersionError on equal version', () => {
    expect(() => ensureMonotonicVersion(5n, 5n)).toThrow(StaleVersionError);
  });

  it('throws StaleVersionError on smaller version', () => {
    expect(() => ensureMonotonicVersion(5n, 4n)).toThrow(StaleVersionError);
  });

  it('throws StaleVersionError on zero when current > 0', () => {
    expect(() => ensureMonotonicVersion(1n, 0n)).toThrow(StaleVersionError);
  });

  it('the error message includes both versions for diagnostics', () => {
    try {
      ensureMonotonicVersion(7n, 3n);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StaleVersionError);
      expect((err as StaleVersionError).message).toContain('7');
      expect((err as StaleVersionError).message).toContain('3');
      expect((err as StaleVersionError).code).toBe('STALE_VERSION');
    }
  });

  it('property: rejects every (current, next) where next <= current', () => {
    fc.assert(
      fc.property(fc.bigUintN(64), fc.bigUintN(64), (a, b) => {
        const current = a > b ? a : b;
        const next = a > b ? b : a;
        try {
          ensureMonotonicVersion(current, next);
          return current < next;
        } catch (err) {
          return err instanceof StaleVersionError && next <= current;
        }
      }),
      { numRuns: 200 },
    );
  });

  it('property: accepts every (current, next) where next > current', () => {
    fc.assert(
      fc.property(fc.bigUintN(63), fc.bigUintN(63), (current, bump) => {
        const next = current + bump + 1n;
        ensureMonotonicVersion(current, next);
        return true;
      }),
      { numRuns: 200 },
    );
  });
});

describe('isStrictlyNewer', () => {
  it('returns true iff a.version > b.version', () => {
    expect(isStrictlyNewer({ version: 2n }, { version: 1n })).toBe(true);
    expect(isStrictlyNewer({ version: 1n }, { version: 1n })).toBe(false);
    expect(isStrictlyNewer({ version: 0n }, { version: 1n })).toBe(false);
  });

  it('property: matches the bigint comparison', () => {
    fc.assert(
      fc.property(fc.bigUintN(64), fc.bigUintN(64), (a, b) => {
        return isStrictlyNewer({ version: a }, { version: b }) === a > b;
      }),
      { numRuns: 200 },
    );
  });
});
