import { describe, expect, it } from 'vitest';
import { FlatPlusBpsFeePolicy } from './fee-policy.js';

describe('FlatPlusBpsFeePolicy', () => {
  it('charges 0.1% + 1 unit by default', () => {
    const policy = new FlatPlusBpsFeePolicy();
    expect(policy.quote(10_000n)).toBe(11n);
  });

  it('respects custom bps', () => {
    const policy = new FlatPlusBpsFeePolicy(50n, 0n);
    expect(policy.quote(10_000n)).toBe(50n);
  });

  it('default constructor leaves bucket disabled (paddingToBucket = 0)', () => {
    const policy = new FlatPlusBpsFeePolicy();
    const q = policy.quoteBucketed(10_000n);
    expect(q.paddingToBucket).toBe(0n);
    expect(q.fee).toBe(11n);
    expect(q.senderHtlcAmount).toBe(10_000n + 11n);
    expect(q.outgoingAmount).toBe(10_000n);
  });

  it('rejects a negative bucket', () => {
    expect(() => new FlatPlusBpsFeePolicy(10n, 1n, -1n)).toThrow();
  });
});

describe('FlatPlusBpsFeePolicy bucketing (item 4)', () => {
  it('rounds the sender HTLC up to the next bucket boundary', () => {
    // base = 10_000 + (10_000 * 10 / 10_000) + 1 = 10_011
    // bucket = 1_000 → next multiple is 11_000, padding = 989
    const policy = new FlatPlusBpsFeePolicy(10n, 1n, 1_000n);
    const q = policy.quoteBucketed(10_000n);
    expect(q.senderHtlcAmount).toBe(11_000n);
    expect(q.paddingToBucket).toBe(989n);
    expect(q.fee).toBe(11n + 989n);
    expect(q.outgoingAmount).toBe(10_000n);
  });

  it('produces senderHtlc that is always a multiple of the bucket', () => {
    const policy = new FlatPlusBpsFeePolicy(10n, 1n, 1_000n);
    for (const amount of [1n, 999n, 1_000n, 1_001n, 12_345n, 999_999n]) {
      const q = policy.quoteBucketed(amount);
      expect(q.senderHtlcAmount % 1_000n).toBe(0n);
      expect(q.senderHtlcAmount).toBeGreaterThanOrEqual(amount + (amount * 10n) / 10_000n + 1n);
      expect(q.paddingToBucket).toBeGreaterThanOrEqual(0n);
      expect(q.paddingToBucket).toBeLessThan(1_000n);
    }
  });

  it('two slightly different amounts collapse into the same bucket', () => {
    // privacy property: adjacent payments are indistinguishable from the
    // outer-HTLC value alone.
    const policy = new FlatPlusBpsFeePolicy(10n, 1n, 1_000n);
    const a = policy.quoteBucketed(10_000n).senderHtlcAmount;
    const b = policy.quoteBucketed(10_500n).senderHtlcAmount;
    expect(a).toBe(b);
  });

  it('no padding when the base already lands on a bucket boundary', () => {
    // base = 9_999 + (9_999 * 0 / 10_000) + 1 = 10_000  -> already a multiple
    const policy = new FlatPlusBpsFeePolicy(0n, 1n, 1_000n);
    const q = policy.quoteBucketed(9_999n);
    expect(q.senderHtlcAmount).toBe(10_000n);
    expect(q.paddingToBucket).toBe(0n);
    expect(q.fee).toBe(1n);
  });

  it('zero bucket disables padding entirely (back-compat with v1)', () => {
    const policy = new FlatPlusBpsFeePolicy(10n, 1n, 0n);
    expect(policy.quote(10_000n)).toBe(11n);
    expect(policy.quoteBucketed(10_000n).paddingToBucket).toBe(0n);
  });

  it('quote() returns total fee including bucket padding', () => {
    const policy = new FlatPlusBpsFeePolicy(10n, 1n, 1_000n);
    const total = policy.quote(10_000n);
    const detailed = policy.quoteBucketed(10_000n);
    expect(total).toBe(detailed.fee);
  });

  it('preserves balance conservation: senderHtlc = outgoing + fee', () => {
    const policy = new FlatPlusBpsFeePolicy(25n, 5n, 500n);
    for (const amount of [10n, 1_234n, 7_777n, 100_000n]) {
      const q = policy.quoteBucketed(amount);
      expect(q.senderHtlcAmount).toBe(q.outgoingAmount + q.fee);
    }
  });
});
