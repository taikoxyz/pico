import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  decryptPrivateKey,
  encryptPrivateKey,
  isEncryptedKeyFile,
  parseKeyFile,
  serializeKeyFile,
} from './key-file.js';

const PK = '0x0000000000000000000000000000000000000000000000000000000000000b0b' as const;
const FAST_SCRYPT = { N: 1024 } as const;

describe('encrypted hot-key file', () => {
  it('round-trips encrypt -> decrypt', () => {
    const env = encryptPrivateKey(PK, 'correct horse battery staple', FAST_SCRYPT);
    expect(env.address.toLowerCase()).toBe(privateKeyToAccount(PK).address.toLowerCase());
    expect(env.version).toBe(1);
    expect(env.kdf.name).toBe('scrypt');
    expect(env.cipher.name).toBe('xsalsa20-poly1305');
    const back = decryptPrivateKey(env, 'correct horse battery staple');
    expect(back).toBe(PK);
  });

  it('rejects wrong passphrase with a clean error', () => {
    const env = encryptPrivateKey(PK, 'right pass', FAST_SCRYPT);
    expect(() => decryptPrivateKey(env, 'wrong pass')).toThrow(/bad passphrase|corrupt/i);
  });

  it('serializes to JSON and parses back', () => {
    const env = encryptPrivateKey(PK, 'pw', FAST_SCRYPT);
    const json = serializeKeyFile(env);
    const parsed = parseKeyFile(json);
    expect(parsed.address).toBe(env.address);
    expect(parsed.kdf.salt).toBe(env.kdf.salt);
    expect(parsed.cipher.ciphertext).toBe(env.cipher.ciphertext);
  });

  it('parseKeyFile rejects malformed input', () => {
    expect(() => parseKeyFile('{}')).toThrow();
    expect(() => parseKeyFile('not json')).toThrow();
    expect(() => parseKeyFile('null')).toThrow();
    expect(() => parseKeyFile(JSON.stringify({ version: 2 }))).toThrow(/unsupported version/);
  });

  it('isEncryptedKeyFile distinguishes envelopes from plaintext keys', () => {
    const env = encryptPrivateKey(PK, 'pw', FAST_SCRYPT);
    const json = serializeKeyFile(env);
    expect(isEncryptedKeyFile(json)).toBe(true);
    expect(isEncryptedKeyFile(PK)).toBe(false);
    expect(isEncryptedKeyFile('garbage')).toBe(false);
  });

  it('rejects non-32-byte hex', () => {
    expect(() => encryptPrivateKey('0xdead' as `0x${string}`, 'pw', FAST_SCRYPT)).toThrow();
  });
});
