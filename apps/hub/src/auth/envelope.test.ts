import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrations.js';
import { NonceRepo } from '../db/repos/index.js';
import { openSqliteDriver } from '../db/sqlite.js';
import type { DbDriver } from '../db/types.js';
import { type SignedEnvelope, envelopeDigest, verifyEnvelope } from './envelope.js';

describe('verifyEnvelope', () => {
  let tmp: string;
  let driver: DbDriver;
  let nonceRepo: NonceRepo;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'hub-env-'));
    driver = openSqliteDriver({ url: join(tmp, 'test.sqlite') });
    await runMigrations(driver);
    nonceRepo = new NonceRepo(driver);
  });
  afterEach(async () => {
    await driver.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function buildEnvelope(
    privateKey: `0x${string}`,
    payload: string,
  ): Promise<SignedEnvelope> {
    const account = privateKeyToAccount(privateKey);
    const nonce = `0x${Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, '0')}${'aa'.repeat(12)}` as `0x${string}`;
    const ts = Date.now();
    const digest = envelopeDigest({ nonce, ts, payload });
    const sig = await account.sign({ hash: digest });
    return { nonce, ts, payload, sig };
  }

  const SK = '0x0000000000000000000000000000000000000000000000000000000000000a11' as const;

  it('accepts a fresh, well-signed envelope from a known signer', async () => {
    const account = privateKeyToAccount(SK);
    const env = await buildEnvelope(SK, '{"hi":"there"}');
    const result = await verifyEnvelope({
      envelope: env,
      knownSigners: new Set([account.address]),
      nonceRepo,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.signer.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it('rejects a replayed nonce', async () => {
    const account = privateKeyToAccount(SK);
    const env = await buildEnvelope(SK, '{"x":1}');
    const first = await verifyEnvelope({
      envelope: env,
      knownSigners: new Set([account.address]),
      nonceRepo,
    });
    expect(first.ok).toBe(true);
    const second = await verifyEnvelope({
      envelope: env,
      knownSigners: new Set([account.address]),
      nonceRepo,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toMatch(/replayed/);
  });

  it('rejects a stale timestamp', async () => {
    const env = await buildEnvelope(SK, '{}');
    const result = await verifyEnvelope({
      envelope: { ...env, ts: env.ts - 5 * 60 * 1000 },
      knownSigners: new Set([privateKeyToAccount(SK).address]),
      nonceRepo,
      windowMs: 60_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/drift/);
  });

  it('rejects an unknown signer', async () => {
    const env = await buildEnvelope(SK, '{}');
    const result = await verifyEnvelope({
      envelope: env,
      knownSigners: new Set(['0x0000000000000000000000000000000000000099' as `0x${string}`]),
      nonceRepo,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not a known/);
  });
});
