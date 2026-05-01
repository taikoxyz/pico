import { describe, expect, it } from 'vitest';
import { type PayMessage, decodeHubMessage, encodeHubMessage } from './hub-protocol.js';

const baseMessage: PayMessage = {
  id: 'req-1',
  kind: 'pay',
  channelId: '0x0000000000000000000000000000000000000000000000000000000000000001',
  signedState: {
    state: {
      channelId: '0x0000000000000000000000000000000000000000000000000000000000000001',
      version: 5n,
      balanceA: 100n,
      balanceB: 50n,
      htlcs: [],
      finalized: false,
    },
    sigA: { r: '0x11', s: '0x22', v: 27 },
    sigB: { r: '0x33', s: '0x44', v: 28 },
  },
  htlc: {
    id: '0x0000000000000000000000000000000000000000000000000000000000000abc',
    direction: 'AtoB',
    amount: 10n,
    paymentHash: '0xabababababababababababababababababababababababababababababababab',
    expiryMs: 1_800_000_000_000n,
  },
  paymentHash: '0xabababababababababababababababababababababababababababababababab',
  recipient: '0x00000000000000000000000000000000000000b0',
  amount: 10n,
};

describe('hub-protocol encode/decode', () => {
  it('round-trips a complex message preserving bigints', () => {
    const wire = encodeHubMessage(baseMessage);
    const decoded = decodeHubMessage(wire);
    expect(decoded).toEqual(baseMessage);
  });

  it('rejects malformed JSON', () => {
    expect(() => decodeHubMessage('not json')).toThrow();
  });

  it('rejects messages without kind', () => {
    expect(() => decodeHubMessage('{"id":"x"}')).toThrow(/missing or non-string `kind`/);
  });

  it('rejects messages without id', () => {
    expect(() => decodeHubMessage('{"kind":"subscribe"}')).toThrow(/missing or non-string `id`/);
  });

  it('rejects messages with unknown kind', () => {
    expect(() => decodeHubMessage('{"id":"x","kind":"bogus"}')).toThrow(/unknown message kind/);
  });

  it('encodes bigints with $bigint tag', () => {
    const wire = encodeHubMessage(baseMessage);
    expect(wire).toContain('$bigint');
  });
});
