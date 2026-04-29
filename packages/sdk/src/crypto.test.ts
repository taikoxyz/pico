import { describe, expect, it } from 'vitest';
import {
  bytesToHex,
  hexToBytes,
  randomBytes,
  randomHtlcId,
  randomNonce16,
  randomPreimage,
} from './crypto.js';

describe('crypto', () => {
  it('randomPreimage returns 0x + 64 hex chars', () => {
    const p = randomPreimage();
    expect(p).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('randomHtlcId returns 0x + 64 hex chars', () => {
    const id = randomHtlcId();
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('randomNonce16 returns 0x + 32 hex chars', () => {
    const n = randomNonce16();
    expect(n).toMatch(/^0x[0-9a-f]{32}$/);
  });

  it('two random preimages collide with negligible probability', () => {
    expect(randomPreimage()).not.toBe(randomPreimage());
  });

  it('hexToBytes / bytesToHex round-trip', () => {
    const bytes = randomBytes(32);
    const hex = bytesToHex(bytes);
    const back = hexToBytes(hex);
    expect(back).toEqual(bytes);
  });

  it('hexToBytes rejects odd-length hex', () => {
    expect(() => hexToBytes('0xabc' as `0x${string}`)).toThrow();
  });
});
