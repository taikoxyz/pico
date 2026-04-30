import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, makeTestDb } from './_test-helpers.js';
import { DuplicateNonceError } from './nonce-repo.js';

describe('NonceRepo', () => {
  let h: TestDb;
  beforeEach(async () => {
    h = await makeTestDb();
  });
  afterEach(async () => h.cleanup());

  it('records a nonce and detects re-use', async () => {
    await h.repos.nonces.record(
      '0x01',
      '0x00000000000000000000000000000000000000a1',
      Date.now() + 60_000,
    );
    expect(await h.repos.nonces.isSeen('0x01')).toBe(true);
    await expect(
      h.repos.nonces.record('0x01', '0x00000000000000000000000000000000000000a1', Date.now()),
    ).rejects.toBeInstanceOf(DuplicateNonceError);
  });

  it('prune removes only expired nonces', async () => {
    const now = Date.now();
    await h.repos.nonces.record('0xaa', '0x00000000000000000000000000000000000000a1', now - 1);
    await h.repos.nonces.record('0xbb', '0x00000000000000000000000000000000000000a1', now + 60_000);
    const removed = await h.repos.nonces.prune(now);
    expect(removed).toBe(1);
    expect(await h.repos.nonces.isSeen('0xaa')).toBe(false);
    expect(await h.repos.nonces.isSeen('0xbb')).toBe(true);
  });
});
