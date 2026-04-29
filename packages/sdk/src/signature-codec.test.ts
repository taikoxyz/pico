import { describe, expect, it } from 'vitest';
import { hexToSignature, signatureToHex } from './signature-codec.js';

describe('signature-codec', () => {
  it('round-trips a 65-byte hex sig', () => {
    const hex =
      '0x1111111111111111111111111111111111111111111111111111111111111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1b';
    const sig = hexToSignature(hex);
    expect(sig.r).toBe(`0x${'11'.repeat(32)}`);
    expect(sig.s).toBe(`0x${'aa'.repeat(32)}`);
    expect(sig.v).toBe(0x1b);
    expect(signatureToHex(sig)).toBe(hex);
  });

  it('rejects too-short hex', () => {
    expect(() => hexToSignature('0x1234' as `0x${string}`)).toThrow();
  });
});
