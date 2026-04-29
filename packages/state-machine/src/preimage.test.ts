import type { PaymentHash, Preimage } from '@tainnel/protocol';
import { keccak256, sha256 } from 'viem';
import { describe, expect, it } from 'vitest';
import { preimageDigest, verifyPreimage } from './preimage.js';

const PREIMAGE_32 =
  '0x0000000000000000000000000000000000000000000000000000000000000001' as Preimage;
const PREIMAGE_64 =
  '0xdeadbeefcafebabedeadbeefcafebabedeadbeefcafebabedeadbeefcafebabedeadbeefcafebabedeadbeefcafebabedeadbeefcafebabedeadbeefcafebabe' as Preimage;
const PREIMAGE_EMPTY = '0x' as Preimage;

describe('verifyPreimage — D1.2 sha256', () => {
  it('returns true when sha256(preimage) === paymentHash', () => {
    const paymentHash = sha256(PREIMAGE_32) as PaymentHash;
    expect(verifyPreimage(paymentHash, PREIMAGE_32)).toBe(true);
  });

  it('handles a 64-byte preimage', () => {
    const paymentHash = sha256(PREIMAGE_64) as PaymentHash;
    expect(verifyPreimage(paymentHash, PREIMAGE_64)).toBe(true);
  });

  it('handles the empty preimage', () => {
    const paymentHash = sha256(PREIMAGE_EMPTY) as PaymentHash;
    expect(verifyPreimage(paymentHash, PREIMAGE_EMPTY)).toBe(true);
  });

  it('returns false for a wrong preimage of the same length', () => {
    const paymentHash = sha256(PREIMAGE_32) as PaymentHash;
    const wrong = '0x0000000000000000000000000000000000000000000000000000000000000002' as Preimage;
    expect(verifyPreimage(paymentHash, wrong)).toBe(false);
  });

  it('returns false for a wrong preimage of different length', () => {
    const paymentHash = sha256(PREIMAGE_32) as PaymentHash;
    expect(verifyPreimage(paymentHash, PREIMAGE_64)).toBe(false);
  });

  it('LOCK D1.2: keccak256 of the preimage does NOT validate', () => {
    const paymentHash = keccak256(PREIMAGE_32) as PaymentHash;
    expect(verifyPreimage(paymentHash, PREIMAGE_32)).toBe(false);
  });

  it('is case-insensitive on the paymentHash hex', () => {
    const paymentHash = sha256(PREIMAGE_32);
    const upper = paymentHash.toUpperCase().replace('0X', '0x') as PaymentHash;
    expect(verifyPreimage(upper, PREIMAGE_32)).toBe(true);
  });
});

describe('preimageDigest', () => {
  it('returns sha256(preimage)', () => {
    expect(preimageDigest(PREIMAGE_32)).toBe(sha256(PREIMAGE_32));
  });

  it('is deterministic', () => {
    expect(preimageDigest(PREIMAGE_64)).toBe(preimageDigest(PREIMAGE_64));
  });
});
