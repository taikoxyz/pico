import { describe, expect, it } from 'vitest';
import { decodePaymentOption, encodePaymentOption } from './payment-tag.js';

describe('payment-tag', () => {
  it('round-trips encode -> decode', () => {
    const original = {
      method: 'channel' as const,
      token: '0x0000000000000000000000000000000000000123' as const,
      chainId: 167000 as const,
      amount: 5_000_000n,
      recipient: '0x0000000000000000000000000000000000000abc' as const,
      hubHints: ['wss://hub-a.example', 'wss://hub-b.example'],
    };
    const decoded = decodePaymentOption(encodePaymentOption(original));
    expect(decoded.method).toBe(original.method);
    expect(decoded.amount).toBe(original.amount);
    expect(decoded.hubHints).toEqual(original.hubHints);
  });
});
