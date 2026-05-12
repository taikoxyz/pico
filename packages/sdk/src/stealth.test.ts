import type { Hex } from '@inferenceroom/pico-protocol';
import { describe, expect, it } from 'vitest';
import {
  STEALTH_LABEL_USER_A,
  STEALTH_LABEL_USER_B,
  STEALTH_LABEL_WATCHTOWER,
  StealthKeyManager,
  deriveStealthPrivateKey,
} from './stealth.js';

const SCAN_KEY_A = '0x000000000000000000000000000000000000000000000000000000000000a11c' as Hex;
const SCAN_KEY_B = '0x0000000000000000000000000000000000000000000000000000000000000b0b' as Hex;
const NONCE_1 = '0x11111111111111111111111111111111' as Hex;
const NONCE_2 = '0x22222222222222222222222222222222' as Hex;

describe('deriveStealthPrivateKey', () => {
  it('is deterministic for the same (scanKey, label, nonce)', () => {
    const k1 = deriveStealthPrivateKey(SCAN_KEY_A, STEALTH_LABEL_USER_A, NONCE_1);
    const k2 = deriveStealthPrivateKey(SCAN_KEY_A, STEALTH_LABEL_USER_A, NONCE_1);
    expect(k1).toBe(k2);
  });

  it('returns a 0x-prefixed 32-byte hex string', () => {
    const k = deriveStealthPrivateKey(SCAN_KEY_A, STEALTH_LABEL_USER_A, NONCE_1);
    expect(k).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('differs across nonces', () => {
    const k1 = deriveStealthPrivateKey(SCAN_KEY_A, STEALTH_LABEL_USER_A, NONCE_1);
    const k2 = deriveStealthPrivateKey(SCAN_KEY_A, STEALTH_LABEL_USER_A, NONCE_2);
    expect(k1).not.toBe(k2);
  });

  it('differs across labels (domain separation)', () => {
    const a = deriveStealthPrivateKey(SCAN_KEY_A, STEALTH_LABEL_USER_A, NONCE_1);
    const b = deriveStealthPrivateKey(SCAN_KEY_A, STEALTH_LABEL_USER_B, NONCE_1);
    const w = deriveStealthPrivateKey(SCAN_KEY_A, STEALTH_LABEL_WATCHTOWER, NONCE_1);
    expect(a).not.toBe(b);
    expect(a).not.toBe(w);
    expect(b).not.toBe(w);
  });

  it('differs across scan keys', () => {
    const k1 = deriveStealthPrivateKey(SCAN_KEY_A, STEALTH_LABEL_USER_A, NONCE_1);
    const k2 = deriveStealthPrivateKey(SCAN_KEY_B, STEALTH_LABEL_USER_A, NONCE_1);
    expect(k1).not.toBe(k2);
  });

  it('rejects a scan key that is not 32 bytes', () => {
    const short = '0xdead' as Hex;
    expect(() => deriveStealthPrivateKey(short, STEALTH_LABEL_USER_A, NONCE_1)).toThrow();
  });
});

describe('StealthKeyManager', () => {
  it('produces signers whose addresses cluster only via the scan key', () => {
    const mgr = new StealthKeyManager(SCAN_KEY_A);
    const a1 = mgr.addressFor(STEALTH_LABEL_USER_A, NONCE_1);
    const a2 = mgr.addressFor(STEALTH_LABEL_USER_A, NONCE_2);
    expect(a1).not.toBe(a2);
    // Without the scan key, no relationship between a1 and a2 is recoverable.
    expect(a1).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('signerFor() returns a LocalSigner with a deterministic address per (label, nonce)', async () => {
    const mgr = new StealthKeyManager(SCAN_KEY_A);
    const s1 = mgr.signerFor(STEALTH_LABEL_USER_A, NONCE_1);
    const s2 = mgr.signerFor(STEALTH_LABEL_USER_A, NONCE_1);
    expect(await s1.address()).toBe(await s2.address());
  });

  it('randomChannelNonce() returns a 16-byte hex string each call', () => {
    const n1 = StealthKeyManager.randomChannelNonce();
    const n2 = StealthKeyManager.randomChannelNonce();
    expect(n1).toMatch(/^0x[0-9a-f]{32}$/);
    expect(n2).toMatch(/^0x[0-9a-f]{32}$/);
    expect(n1).not.toBe(n2);
  });

  it('rejects a non-32-byte scan key', () => {
    expect(() => new StealthKeyManager('0xdead' as Hex)).toThrow();
  });
});
