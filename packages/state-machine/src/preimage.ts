import type { Hex, PaymentHash, Preimage } from '@pico/protocol';
import { sha256 } from 'viem';

export function preimageDigest(preimage: Preimage): Hex {
  return sha256(preimage);
}

export function verifyPreimage(paymentHash: PaymentHash, preimage: Preimage): boolean {
  return sha256(preimage).toLowerCase() === paymentHash.toLowerCase();
}
