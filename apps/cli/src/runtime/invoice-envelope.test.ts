import type { Invoice } from '@inferenceroom/pico-protocol';
import { describe, expect, it } from 'vitest';
import { decodeInvoiceEnvelope, encodeInvoiceEnvelope } from './invoice-envelope.js';

const INV: Invoice = {
  paymentHash: `0x${'11'.repeat(32)}` as `0x${string}`,
  amount: 50_000n,
  recipient: '0x0000000000000000000000000000000000000005',
  expiryMs: 1_700_000_000_000n,
  nonce: `0x${'aa'.repeat(16)}` as `0x${string}`,
  memo: 'service foo',
  hubHint: 'wss://hub.example.com',
  signature: `0x${'22'.repeat(65)}` as `0x${string}`,
};

describe('invoice envelope', () => {
  it('round-trips with all fields', () => {
    const env = encodeInvoiceEnvelope(INV);
    expect(env.startsWith('pico1:')).toBe(true);
    const back = decodeInvoiceEnvelope(env);
    expect(back).toEqual(INV);
  });

  it('round-trips without optional fields', () => {
    const minimal: Invoice = { ...INV };
    (minimal as { memo?: string }).memo = undefined;
    (minimal as { hubHint?: string }).hubHint = undefined;
    const back = decodeInvoiceEnvelope(encodeInvoiceEnvelope(minimal));
    expect(back).toEqual(minimal);
  });

  it('rejects bad prefix', () => {
    expect(() => decodeInvoiceEnvelope('garbage')).toThrow(/prefix/);
  });

  it('rejects unsupported version', () => {
    const wire = {
      v: 2,
      paymentHash: '0x00',
      amount: '1',
      recipient: '0x00',
      expiryMs: '1',
      nonce: '0x00',
      signature: '0x00',
    };
    const envelope = `pico1:${Buffer.from(JSON.stringify(wire), 'utf8').toString('base64url')}`;
    expect(() => decodeInvoiceEnvelope(envelope)).toThrow(/version/);
  });
});
