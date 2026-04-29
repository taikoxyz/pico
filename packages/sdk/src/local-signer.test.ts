import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { encryptPrivateKey, serializeKeyFile } from './key-file.js';
import { LocalSigner, loadLocalSigner, localSigner } from './local-signer.js';

const PK = '0x0000000000000000000000000000000000000000000000000000000000000b0b' as const;
const ADDR = privateKeyToAccount(PK).address.toLowerCase();
const FAST = { N: 1024 } as const;

describe('LocalSigner / loadLocalSigner', () => {
  it('localSigner produces a Signer with the right address', async () => {
    const s = localSigner(PK);
    expect(s).toBeInstanceOf(LocalSigner);
    expect((await s.address()).toLowerCase()).toBe(ADDR);
  });

  it('localSigner rejects malformed keys', () => {
    expect(() => localSigner('0xnope' as `0x${string}`)).toThrow();
  });

  it('loadLocalSigner: privateKey wins', async () => {
    const s = await loadLocalSigner({
      privateKey: PK,
      env: { TAINNEL_PRIVATE_KEY: `0x${'11'.repeat(32)}` },
    });
    expect((await s.address()).toLowerCase()).toBe(ADDR);
  });

  it('loadLocalSigner: TAINNEL_PRIVATE_KEY env var', async () => {
    const s = await loadLocalSigner({ env: { TAINNEL_PRIVATE_KEY: PK } });
    expect((await s.address()).toLowerCase()).toBe(ADDR);
  });

  it('loadLocalSigner: rejects malformed env var', async () => {
    await expect(loadLocalSigner({ env: { TAINNEL_PRIVATE_KEY: 'not-hex' } })).rejects.toThrow(
      /TAINNEL_PRIVATE_KEY/,
    );
  });

  it('loadLocalSigner: plaintext key file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tainnel-key-'));
    const file = join(dir, 'key.txt');
    writeFileSync(file, `${PK}\n`, { mode: 0o600 });
    const s = await loadLocalSigner({ keyFile: file, env: {} });
    expect((await s.address()).toLowerCase()).toBe(ADDR);
  });

  it('loadLocalSigner: encrypted key file with string passphrase', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tainnel-key-'));
    const file = join(dir, 'key.enc');
    const env = encryptPrivateKey(PK, 'pw', FAST);
    writeFileSync(file, serializeKeyFile(env), { mode: 0o600 });
    const s = await loadLocalSigner({ keyFile: file, passphrase: 'pw', env: {} });
    expect((await s.address()).toLowerCase()).toBe(ADDR);
  });

  it('loadLocalSigner: encrypted key file with async passphrase callback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tainnel-key-'));
    const file = join(dir, 'key.enc');
    const env = encryptPrivateKey(PK, 'pw', FAST);
    writeFileSync(file, serializeKeyFile(env), { mode: 0o600 });
    const s = await loadLocalSigner({ keyFile: file, passphrase: async () => 'pw', env: {} });
    expect((await s.address()).toLowerCase()).toBe(ADDR);
  });

  it('loadLocalSigner: missing source throws', async () => {
    await expect(loadLocalSigner({ env: {} })).rejects.toThrow(/no key source/);
  });

  it('loadLocalSigner: missing key file throws', async () => {
    await expect(
      loadLocalSigner({ keyFile: '/nonexistent/path/key.enc', env: {} }),
    ).rejects.toThrow(/not found/);
  });

  it('loadLocalSigner: encrypted file without passphrase throws', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tainnel-key-'));
    const file = join(dir, 'key.enc');
    const env = encryptPrivateKey(PK, 'pw', FAST);
    writeFileSync(file, serializeKeyFile(env), { mode: 0o600 });
    await expect(loadLocalSigner({ keyFile: file, env: {} })).rejects.toThrow(/passphrase/);
  });
});
