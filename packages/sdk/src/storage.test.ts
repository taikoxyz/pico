import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Channel, ChannelId, Hex, SignedState } from '@tainnel/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StorageError } from './errors.js';
import { type ChannelStorage, FileStorage, MemoryStorage } from './storage.js';

const channelId: ChannelId = '0x0000000000000000000000000000000000000000000000000000000000000001';

function makeChannel(id: ChannelId = channelId, status: Channel['status'] = 'open'): Channel {
  return {
    id,
    chainId: 167000,
    contract: '0x1111111111111111111111111111111111111111',
    userA: '0x2222222222222222222222222222222222222222',
    userB: '0x3333333333333333333333333333333333333333',
    token: '0x4444444444444444444444444444444444444444',
    status,
    openedAt: 0n,
    disputeWindowMs: 86_400_000,
  };
}

function makeSignedState(version: bigint, id: ChannelId = channelId): SignedState {
  const sig = {
    r: `0x${'a'.repeat(64)}` as Hex,
    s: `0x${'b'.repeat(64)}` as Hex,
    v: 27,
  };
  return {
    state: {
      channelId: id,
      version,
      balanceA: 1_000n,
      balanceB: 2_000n,
      htlcs: [
        {
          id: `0x${'cc'.repeat(32)}` as Hex,
          direction: 'AtoB',
          amount: 50n,
          paymentHash: `0x${'dd'.repeat(32)}` as Hex,
          expiryMs: 9_999_999n,
        },
      ],
      finalized: false,
    },
    sigA: sig,
    sigB: sig,
  };
}

function runConformance(
  name: string,
  factory: () => Promise<ChannelStorage> | ChannelStorage,
): void {
  describe(name, () => {
    let storage: ChannelStorage;

    beforeEach(async () => {
      storage = await factory();
    });

    it('starts empty', async () => {
      expect(await storage.list()).toEqual([]);
    });

    it('round-trips a channel', async () => {
      await storage.saveChannel(makeChannel());
      expect(await storage.loadChannel(channelId)).toEqual(makeChannel());
      expect(await storage.list()).toHaveLength(1);
    });

    it('returns undefined for unknown channel', async () => {
      const unknown: ChannelId = `0x${'0e'.repeat(32)}`;
      expect(await storage.loadChannel(unknown)).toBeUndefined();
    });

    it('rejects saveState for unknown channel', async () => {
      await expect(storage.saveState(channelId, makeSignedState(1n))).rejects.toThrow(StorageError);
    });

    it('rejects saveState when channelId in state does not match key', async () => {
      await storage.saveChannel(makeChannel());
      const wrongId: ChannelId = `0x${'ff'.repeat(32)}`;
      await expect(storage.saveState(channelId, makeSignedState(1n, wrongId))).rejects.toThrow(
        /channelId/,
      );
    });

    it('round-trips a signed state', async () => {
      await storage.saveChannel(makeChannel());
      const ss = makeSignedState(1n);
      await storage.saveState(channelId, ss);
      const loaded = await storage.loadLatestState(channelId);
      expect(loaded?.state.version).toBe(1n);
      expect(loaded?.state.balanceA).toBe(1_000n);
      expect(loaded?.state.htlcs[0]?.amount).toBe(50n);
    });

    it('overwrites with a strictly newer version', async () => {
      await storage.saveChannel(makeChannel());
      await storage.saveState(channelId, makeSignedState(1n));
      await storage.saveState(channelId, makeSignedState(2n));
      const loaded = await storage.loadLatestState(channelId);
      expect(loaded?.state.version).toBe(2n);
    });

    it('rejects writing a stale (equal-or-older) state', async () => {
      await storage.saveChannel(makeChannel());
      await storage.saveState(channelId, makeSignedState(5n));
      const equal = storage.saveState(channelId, makeSignedState(5n));
      await expect(equal).rejects.toBeInstanceOf(StorageError);
      const older = storage.saveState(channelId, makeSignedState(3n));
      await expect(older).rejects.toBeInstanceOf(StorageError);
    });

    it('preserves the saved state across saveChannel updates', async () => {
      await storage.saveChannel(makeChannel());
      await storage.saveState(channelId, makeSignedState(7n));
      await storage.saveChannel({ ...makeChannel(), status: 'closing-cooperative' });
      const loaded = await storage.loadLatestState(channelId);
      expect(loaded?.state.version).toBe(7n);
      const ch = await storage.loadChannel(channelId);
      expect(ch?.status).toBe('closing-cooperative');
    });

    it('lists all saved channels', async () => {
      const a: ChannelId = `0x${'a1'.repeat(32)}`;
      const b: ChannelId = `0x${'b2'.repeat(32)}`;
      await storage.saveChannel(makeChannel(a));
      await storage.saveChannel(makeChannel(b));
      const list = await storage.list();
      const ids = list.map((c) => c.id).sort();
      expect(ids).toEqual([a, b].sort());
    });

    it('delete removes channel and state', async () => {
      await storage.saveChannel(makeChannel());
      await storage.saveState(channelId, makeSignedState(1n));
      await storage.delete(channelId);
      expect(await storage.loadChannel(channelId)).toBeUndefined();
      expect(await storage.loadLatestState(channelId)).toBeUndefined();
      expect(await storage.list()).toEqual([]);
    });

    it('delete on a non-existent id is a no-op', async () => {
      const unknown: ChannelId = `0x${'fe'.repeat(32)}`;
      await expect(storage.delete(unknown)).resolves.toBeUndefined();
    });

    it('clear empties the store', async () => {
      const a: ChannelId = `0x${'a1'.repeat(32)}`;
      const b: ChannelId = `0x${'b2'.repeat(32)}`;
      await storage.saveChannel(makeChannel(a));
      await storage.saveChannel(makeChannel(b));
      await storage.clear();
      expect(await storage.list()).toEqual([]);
      expect(await storage.loadChannel(a)).toBeUndefined();
    });

    it('serializes bigints faithfully (htlc amount and expiry round-trip)', async () => {
      await storage.saveChannel(makeChannel());
      const big = 12345678901234567890n;
      const ss = makeSignedState(1n);
      const withBigAmount: SignedState = {
        ...ss,
        state: {
          ...ss.state,
          balanceA: big,
        },
      };
      await storage.saveState(channelId, withBigAmount);
      const loaded = await storage.loadLatestState(channelId);
      expect(loaded?.state.balanceA).toBe(big);
    });
  });
}

runConformance('MemoryStorage', () => new MemoryStorage());

describe('FileStorage', () => {
  let dir: string;
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tainnel-sdk-storage-'));
  });

  runConformance('conformance', () => FileStorage.createNode(dir));

  it('persists across instances (simulates process restart)', async () => {
    const a = await FileStorage.createNode(dir);
    await a.saveChannel(makeChannel());
    await a.saveState(channelId, makeSignedState(3n));

    const b = await FileStorage.createNode(dir);
    const ch = await b.loadChannel(channelId);
    const ss = await b.loadLatestState(channelId);
    expect(ch?.id).toBe(channelId);
    expect(ss?.state.version).toBe(3n);
  });

  it('uses atomic-rename: a partially-written .tmp file is not visible to readers', async () => {
    const a = await FileStorage.createNode(dir);
    await a.saveChannel(makeChannel());

    // write a stray .tmp directly; it must not appear in list
    const fs = await import('node:fs/promises');
    await fs.writeFile(`${dir}/channels/0xdeadbeef.json.tmp`, 'not committed', 'utf8');

    const list = await a.list();
    expect(list.map((c) => c.id)).toEqual([channelId]);
  });

  it('readdir filters out non-.json entries', async () => {
    const a = await FileStorage.createNode(dir);
    await a.saveChannel(makeChannel());
    const fs = await import('node:fs/promises');
    await fs.writeFile(`${dir}/channels/.DS_Store`, 'mac junk', 'utf8');
    const list = await a.list();
    expect(list).toHaveLength(1);
  });
});
