import { describe, expect, it } from 'vitest';
import { MemoryStorage } from './storage.js';

describe('MemoryStorage', () => {
  it('round-trips a stored channel', async () => {
    const storage = new MemoryStorage();
    expect(await storage.list()).toEqual([]);
    await storage.saveChannel({
      id: '0x01',
      chainId: 167000,
      contract: '0x0000000000000000000000000000000000000000',
      userA: '0x0000000000000000000000000000000000000001',
      userB: '0x0000000000000000000000000000000000000002',
      token: '0x0000000000000000000000000000000000000000',
      status: 'open',
      openedAt: 0n,
      disputeWindowMs: 86_400_000,
    });
    expect((await storage.list()).length).toBe(1);
  });
});
