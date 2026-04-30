import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, makeTestDb } from './_test-helpers.js';

describe('DisputeRepo', () => {
  let h: TestDb;
  beforeEach(async () => {
    h = await makeTestDb();
  });
  afterEach(async () => h.cleanup());

  it('records, marks responded, and resolves', async () => {
    await h.repos.disputes.record('0xaa', 5n, Date.now());
    await h.repos.disputes.markResponded('0xaa', 5n, '0xtxhash', Date.now());
    await h.repos.disputes.markResolution('0xaa', 5n, 'won');

    const all = await h.repos.disputes.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.responseTxHash).toBe('0xtxhash');
    expect(all[0]?.resolution).toBe('won');
  });

  it('record is idempotent on (channelId, version)', async () => {
    await h.repos.disputes.record('0xaa', 5n, 1);
    await h.repos.disputes.record('0xaa', 5n, 2);
    expect((await h.repos.disputes.list()).length).toBe(1);
  });

  it('countByResolution returns zeros for missing buckets', async () => {
    await h.repos.disputes.record('0xaa', 5n, 1);
    const counts = await h.repos.disputes.countByResolution();
    expect(counts.pending).toBe(1);
    expect(counts.won).toBe(0);
    expect(counts.lost).toBe(0);
  });
});
