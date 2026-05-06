import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptPrivateKey, serializeKeyFile } from '@inferenceroom/pico-sdk';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { resolvePrivateKey, resolveSigner } from './signer.js';

const PK = '0x0000000000000000000000000000000000000000000000000000000000000b0b' as const;
const ADDR = privateKeyToAccount(PK).address.toLowerCase();
const FAST = { N: 1024 } as const;

class StubStderr {
  buf = '';
  write(s: string): void {
    this.buf += s;
  }
}

describe('resolveSigner', () => {
  it('uses --private-key (warns)', async () => {
    const stderr = new StubStderr();
    const s = await resolveSigner({ privateKey: PK, env: {}, stderr });
    expect((await s.address()).toLowerCase()).toBe(ADDR);
    expect(stderr.buf).toContain('warn');
  });

  it('uses PICO_PRIVATE_KEY env (warns)', async () => {
    const stderr = new StubStderr();
    const s = await resolveSigner({ env: { PICO_PRIVATE_KEY: PK }, stderr });
    expect((await s.address()).toLowerCase()).toBe(ADDR);
    expect(stderr.buf).toContain('warn');
  });

  it('falls back to encrypted key file with passphrase prompt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pico-sig-'));
    const keyFile = join(dir, 'key.enc');
    const env = encryptPrivateKey(PK, 'pw', FAST);
    writeFileSync(keyFile, serializeKeyFile(env), { mode: 0o600 });
    const s = await resolveSigner({
      keyFile,
      env: { PICO_PASSPHRASE: 'pw' },
      stderr: new StubStderr(),
    });
    expect((await s.address()).toLowerCase()).toBe(ADDR);
  });

  it('errors when no source available', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pico-sig-'));
    await expect(
      resolveSigner({ env: { PICO_CONFIG_DIR: dir }, stderr: new StubStderr() }),
    ).rejects.toThrow(/no key source/);
  });
});

describe('resolvePrivateKey', () => {
  it('returns the private key from --private-key', async () => {
    expect(await resolvePrivateKey({ privateKey: PK, env: {} })).toBe(PK);
  });

  it('returns the private key from env var', async () => {
    expect(await resolvePrivateKey({ env: { PICO_PRIVATE_KEY: PK } })).toBe(PK);
  });

  it('decrypts an encrypted key file using PICO_PASSPHRASE', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pico-sig-'));
    const keyFile = join(dir, 'key.enc');
    const env = encryptPrivateKey(PK, 'pw', FAST);
    writeFileSync(keyFile, serializeKeyFile(env), { mode: 0o600 });
    const got = await resolvePrivateKey({
      keyFile,
      env: { PICO_PASSPHRASE: 'pw' },
    });
    expect(got).toBe(PK);
  });

  it('reads a plaintext key file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pico-sig-'));
    const keyFile = join(dir, 'key.txt');
    writeFileSync(keyFile, `${PK}\n`, { mode: 0o600 });
    expect(await resolvePrivateKey({ keyFile, env: {} })).toBe(PK);
  });

  it('errors when env var malformed', async () => {
    await expect(resolvePrivateKey({ env: { PICO_PRIVATE_KEY: 'not-hex' } })).rejects.toThrow();
  });
});
