import { describe, expect, it } from 'vitest';
import { generateKeysendKeypair, openSealed, sealForRecipient } from './keysend.js';

describe('keysend sealed box', () => {
  it('round-trips a payload between sender and recipient', () => {
    const recipient = generateKeysendKeypair();
    const payload = { preimage: '0xdead', memo: 'pizza' };
    const sealed = sealForRecipient(payload, recipient.publicKey);
    const opened = openSealed(sealed, recipient.secretKey);
    expect(opened).toEqual(payload);
  });

  it('rejects decryption with the wrong secret key', () => {
    const recipient = generateKeysendKeypair();
    const wrong = generateKeysendKeypair();
    const sealed = sealForRecipient({ x: 1 }, recipient.publicKey);
    expect(() => openSealed(sealed, wrong.secretKey)).toThrow();
  });

  it('rejects tampered ciphertext', () => {
    const recipient = generateKeysendKeypair();
    const sealed = sealForRecipient({ x: 1 }, recipient.publicKey);
    const tampered = {
      ...sealed,
      ciphertext: `${sealed.ciphertext.slice(0, -2)}ff` as `0x${string}`,
    };
    expect(() => openSealed(tampered, recipient.secretKey)).toThrow();
  });

  it('two seals of the same payload differ (random nonce + ephemeral key)', () => {
    const recipient = generateKeysendKeypair();
    const a = sealForRecipient({ x: 1 }, recipient.publicKey);
    const b = sealForRecipient({ x: 1 }, recipient.publicKey);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.nonce).not.toBe(b.nonce);
  });
});
