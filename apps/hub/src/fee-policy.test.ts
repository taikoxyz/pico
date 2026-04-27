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
});
