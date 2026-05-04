import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keysCommand } from './keys.js';

class StubStream {
  buf = '';
  write(s: string): void {
    this.buf += s;
  }
}

const PK = '0x0000000000000000000000000000000000000000000000000000000000000b0b' as const;
const ADDR = privateKeyToAccount(PK).address.toLowerCase();
const FAKE_NEW_KEY = '0x000000000000000000000000000000000000000000000000000000000000a11c' as const;
const FAKE_NEW_ADDR = privateKeyToAccount(FAKE_NEW_KEY).address.toLowerCase();

describe('pico keys', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  let stdout: StubStream;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pico-keys-'));
    env = { PICO_CONFIG_DIR: dir, PICO_PASSPHRASE: 'pw' };
    stdout = new StubStream();
  });

  afterEach(() => {
    /* tmp cleaned by os */
  });

  it('init writes a 0600 encrypted file with the address printed', async () => {
    const cmd = keysCommand({ env, stdout, generatePrivateKey: () => FAKE_NEW_KEY });
    await cmd.parseAsync(['node', 'pico', 'init']);
    const path = join(dir, 'key.enc');
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(stdout.buf.toLowerCase()).toContain(`address: ${FAKE_NEW_ADDR}`);
  });

  it('init refuses to overwrite without --force', async () => {
    const path = join(dir, 'key.enc');
    writeFileSync(path, '{}', { mode: 0o600 });
    const cmd = keysCommand({ env, stdout, generatePrivateKey: () => FAKE_NEW_KEY });
    await expect(cmd.parseAsync(['node', 'pico', 'init'])).rejects.toThrow(/refuse/);
  });

  it('init --force overwrites existing file', async () => {
    const path = join(dir, 'key.enc');
    writeFileSync(path, '{}', { mode: 0o600 });
    const cmd = keysCommand({ env, stdout, generatePrivateKey: () => FAKE_NEW_KEY });
    await cmd.parseAsync(['node', 'pico', 'init', '--force']);
    expect(stdout.buf.toLowerCase()).toContain(FAKE_NEW_ADDR);
  });

  it('import writes file with the imported address', async () => {
    const cmd = keysCommand({ env, stdout });
    await cmd.parseAsync(['node', 'pico', 'import', '--from', PK]);
    expect(stdout.buf.toLowerCase()).toContain(ADDR);
  });

  it('import rejects malformed hex', async () => {
    const cmd = keysCommand({ env, stdout });
    await expect(cmd.parseAsync(['node', 'pico', 'import', '--from', '0xnope'])).rejects.toThrow(
      /expected/i,
    );
  });

  it('show prints address from an encrypted file', async () => {
    const cmd1 = keysCommand({ env, stdout, generatePrivateKey: () => FAKE_NEW_KEY });
    await cmd1.parseAsync(['node', 'pico', 'init']);
    const out = new StubStream();
    const cmd2 = keysCommand({ env, stdout: out });
    await cmd2.parseAsync(['node', 'pico', 'show']);
    expect(out.buf).toContain('format:  encrypted');
    expect(out.buf.toLowerCase()).toContain(FAKE_NEW_ADDR);
  });

  it('show --reveal-private decrypts using passphrase', async () => {
    const importStdout = new StubStream();
    const cmd1 = keysCommand({ env, stdout: importStdout });
    await cmd1.parseAsync(['node', 'pico', 'import', '--from', PK]);
    const showOut = new StubStream();
    const cmd2 = keysCommand({ env, stdout: showOut });
    await cmd2.parseAsync(['node', 'pico', 'show', '--reveal-private']);
    expect(showOut.buf).toContain(`private: ${PK}`);
  });

  it('show recognizes plaintext key files', async () => {
    const path = join(dir, 'key.txt');
    writeFileSync(path, `${PK}\n`, { mode: 0o600 });
    const cmd = keysCommand({ env, stdout });
    await cmd.parseAsync(['node', 'pico', 'show', '--path', path]);
    expect(stdout.buf).toContain('format:  plaintext');
  });
});
