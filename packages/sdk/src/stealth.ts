import type { Address, Hex } from '@inferenceroom/pico-protocol';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, randomBytes } from './crypto.js';
import { LocalSigner } from './local-signer.js';

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const MAX_RETRIES = 256;

function bytesToBigInt(buf: Uint8Array): bigint {
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  return n;
}

function encodeMessage(label: string, nonce: Hex, counter: number): Uint8Array {
  const labelBytes = new TextEncoder().encode(label);
  const nonceBytes = hexToBytes(nonce);
  const out = new Uint8Array(labelBytes.length + 1 + nonceBytes.length + 1);
  out.set(labelBytes, 0);
  out[labelBytes.length] = 0x00;
  out.set(nonceBytes, labelBytes.length + 1);
  out[out.length - 1] = counter & 0xff;
  return out;
}

export function deriveStealthPrivateKey(scanKey: Hex, label: string, nonce: Hex): Hex {
  const key = hexToBytes(scanKey);
  if (key.length !== 32) throw new Error('deriveStealthPrivateKey: scanKey must be 32 bytes');
  for (let i = 0; i < MAX_RETRIES; i++) {
    const out = hmac(sha256, key, encodeMessage(label, nonce, i));
    const scalar = bytesToBigInt(out);
    if (scalar > 0n && scalar < SECP256K1_N) {
      return bytesToHex(out);
    }
  }
  // Cryptographically unreachable; HMAC-SHA256 outputs fall in-range with overwhelming probability.
  throw new Error('deriveStealthPrivateKey: exhausted retries');
}

/** Domain-separation label for a per-channel sender (`userA`) stealth key. */
export const STEALTH_LABEL_USER_A = 'pico-stealth-userA' as const;
/** Domain-separation label for a per-channel recipient (`userB`) stealth key. */
export const STEALTH_LABEL_USER_B = 'pico-stealth-userB' as const;
/**
 * Reserved: domain-separation label for the watchtower's per-channel
 * monitor key. The watchtower receives this derived key (not the user's
 * scan key) so it can post dispute challenges without spend authority.
 * Wired up by the watchtower-binding flow — not yet consumed in this PR.
 */
export const STEALTH_LABEL_WATCHTOWER = 'pico-stealth-watch' as const;

export type StealthLabel =
  | typeof STEALTH_LABEL_USER_A
  | typeof STEALTH_LABEL_USER_B
  | typeof STEALTH_LABEL_WATCHTOWER;

export class StealthKeyManager {
  constructor(private readonly scanKey: Hex) {
    if (hexToBytes(scanKey).length !== 32) {
      throw new Error('StealthKeyManager: scanKey must be 32 bytes');
    }
  }

  derivePrivateKey(label: StealthLabel, nonce: Hex): Hex {
    return deriveStealthPrivateKey(this.scanKey, label, nonce);
  }

  signerFor(label: StealthLabel, nonce: Hex): LocalSigner {
    return new LocalSigner(this.derivePrivateKey(label, nonce));
  }

  addressFor(label: StealthLabel, nonce: Hex): Address {
    return this.signerFor(label, nonce).addressSync();
  }

  static randomChannelNonce(): Hex {
    return bytesToHex(randomBytes(16));
  }
}
