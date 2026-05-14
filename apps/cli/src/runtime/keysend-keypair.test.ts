import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadOrCreateKeysendKeypair } from './keysend-keypair.js';

describe('loadOrCreateKeysendKeypair', () => {
  it('generates and persists a keypair when the file does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pico-keysend-'));
    try {
      const path = join(dir, 'keysend.json');
      const kp = loadOrCreateKeysendKeypair(path);
      expect(kp.publicKey).toMatch(/^0x[0-9a-fA-F]+$/);
      expect(kp.secretKey).toMatch(/^0x[0-9a-fA-F]+$/);
      const stat = statSync(path);
      expect(stat.mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns the same keypair across calls (no regeneration on restart)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pico-keysend-'));
    try {
      const path = join(dir, 'keysend.json');
      const first = loadOrCreateKeysendKeypair(path);
      const second = loadOrCreateKeysendKeypair(path);
      expect(second.publicKey).toBe(first.publicKey);
      expect(second.secretKey).toBe(first.secretKey);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a malformed keypair file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pico-keysend-'));
    try {
      const path = join(dir, 'keysend.json');
      const fs = require('node:fs') as typeof import('node:fs');
      fs.writeFileSync(path, JSON.stringify({ publicKey: 'not-hex' }));
      expect(() => loadOrCreateKeysendKeypair(path)).toThrow(/malformed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
