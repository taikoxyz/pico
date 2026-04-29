import { describe, expect, it } from 'vitest';
import { CliError } from './errors.js';
import { formatUsdc, parseUsdc } from './units.js';

describe('parseUsdc', () => {
  it('integers → 6-decimal bigint', () => {
    expect(parseUsdc('5')).toBe(5_000_000n);
    expect(parseUsdc('0')).toBe(0n);
    expect(parseUsdc('1000000')).toBe(1_000_000_000_000n);
  });

  it('fractions are scaled and right-padded', () => {
    expect(parseUsdc('0.5')).toBe(500_000n);
    expect(parseUsdc('1.000001')).toBe(1_000_001n);
    expect(parseUsdc('1.1')).toBe(1_100_000n);
  });

  it('throws CliError on > 6 decimals', () => {
    expect(() => parseUsdc('1.0000001')).toThrow(CliError);
  });

  it.each(['', 'abc', '1.', '.5', '1,5', '-1', '1e6'])('throws on invalid input: %s', (bad) => {
    expect(() => parseUsdc(bad)).toThrow(CliError);
  });
});

describe('formatUsdc', () => {
  it('round-trips via parseUsdc', () => {
    for (const s of ['0', '1', '5', '0.5', '1.123456', '1234.567']) {
      expect(formatUsdc(parseUsdc(s))).toBe(s);
    }
  });

  it('handles 0', () => {
    expect(formatUsdc(0n)).toBe('0');
  });

  it('handles negatives', () => {
    expect(formatUsdc(-500_000n)).toBe('-0.5');
  });
});
