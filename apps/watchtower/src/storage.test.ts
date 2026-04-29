import type { ChannelId, Hex, SignedState } from '@tainnel/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations } from './migrations.js';
import {
  MemoryBackupStore,
  type Observation,
  ObservationRepo,
  type SqliteHandle,
  SqliteStateStore,
  openSqlite,
} from './storage.js';

const channelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as ChannelId;

function makeSignedState(version: bigint, balanceA = 0n, balanceB = 0n): SignedState {
  return {
    state: {
      channelId,
      version,
      balanceA,
      balanceB,
      htlcs: [],
      finalized: false,
    },
    sigA: { r: '0xaa' as Hex, s: '0xbb' as Hex, v: 27 },
    sigB: { r: '0xcc' as Hex, s: '0xdd' as Hex, v: 28 },
  };
}

describe('MemoryBackupStore', () => {
  it('keeps the highest-version backup', async () => {
    const store = new MemoryBackupStore();
    await store.put({
      channelId,
      version: 5n,
      ciphertext: new Uint8Array(),
      nonce: new Uint8Array(),
    });
    await store.put({
      channelId,
      version: 3n,
      ciphertext: new Uint8Array(),
      nonce: new Uint8Array(),
    });
    const got = await store.latest(channelId);
    expect(got?.version).toBe(5n);
  });

  it('returns undefined for unknown channels', async () => {
    const store = new MemoryBackupStore();
    expect(await store.latest(channelId)).toBeUndefined();
  });
});

describe('migrations', () => {
  it('is idempotent', () => {
    const handle = openSqlite(':memory:');
    applyMigrations(handle.raw);
    applyMigrations(handle.raw);
    const rows = handle.raw.prepare('SELECT version FROM _schema_migrations').all() as Array<{
      version: number;
    }>;
    expect(rows.map((r) => r.version)).toEqual([1]);
    handle.close();
  });
});

describe('SqliteStateStore', () => {
  let handle: SqliteHandle;
  let store: SqliteStateStore;

  beforeEach(() => {
    handle = openSqlite(':memory:');
    store = new SqliteStateStore(handle.raw);
  });

  afterEach(() => handle.close());

  it('round-trips a signed state', async () => {
    const s = makeSignedState(10n, 100n, 200n);
    await store.put(s);
    const got = await store.latest(channelId);
    expect(got?.state.version).toBe(10n);
    expect(got?.state.balanceA).toBe(100n);
    expect(got?.state.balanceB).toBe(200n);
  });

  it('returns the highest version on latest()', async () => {
    await store.put(makeSignedState(5n));
    await store.put(makeSignedState(8n));
    await store.put(makeSignedState(7n));
    const got = await store.latest(channelId);
    expect(got?.state.version).toBe(8n);
  });

  it("lists every channel's latest state", async () => {
    const otherChannel =
      '0x0000000000000000000000000000000000000000000000000000000000000002' as ChannelId;
    await store.put(makeSignedState(3n));
    await store.put(makeSignedState(4n));
    await store.put({
      ...makeSignedState(7n),
      state: { ...makeSignedState(7n).state, channelId: otherChannel },
    });
    const list = await store.list();
    expect(list).toHaveLength(2);
    const versions = list.map((s) => s.state.version).sort();
    expect(versions).toEqual([4n, 7n]);
  });
});

describe('ObservationRepo', () => {
  let handle: SqliteHandle;
  let repo: ObservationRepo;

  beforeEach(() => {
    handle = openSqlite(':memory:');
    repo = new ObservationRepo(handle.raw);
  });

  afterEach(() => handle.close());

  function obs(over: Partial<Observation> = {}): Observation {
    return {
      channelId,
      postedVersion: 5n,
      postedAt: 1_000,
      ourLatestVersion: 10n,
      actionTaken: 'penalize',
      submitBy: 1_500,
      ...over,
    };
  }

  it('inserts and reads back an observation', () => {
    repo.record(obs());
    const got = repo.get(channelId);
    expect(got?.ourLatestVersion).toBe(10n);
    expect(got?.actionTaken).toBe('penalize');
  });

  it('pendingObservations returns rows whose submit_by has elapsed', () => {
    repo.record(obs({ submitBy: 1_500 }));
    expect(repo.pendingObservations(1_400)).toHaveLength(0);
    expect(repo.pendingObservations(1_500)).toHaveLength(1);
    expect(repo.pendingObservations(2_000)).toHaveLength(1);
  });

  it('skips observations once tx_hash is recorded', () => {
    repo.record(obs());
    repo.markSubmitted(channelId, '0xtx' as Hex, 1_600);
    expect(repo.pendingObservations(2_000)).toHaveLength(0);
    const got = repo.get(channelId);
    expect(got?.txHash).toBe('0xtx');
    expect(got?.submittedAt).toBe(1_600);
  });

  it('marks included_at independently', () => {
    repo.record(obs());
    repo.markIncluded(channelId, 9_999);
    expect(repo.get(channelId)?.includedAt).toBe(9_999);
  });

  it('round-trips meta key/values', () => {
    repo.setMeta('last_block', '12345');
    expect(repo.getMeta('last_block')).toBe('12345');
    repo.setMeta('last_block', '67890');
    expect(repo.getMeta('last_block')).toBe('67890');
    expect(repo.getMeta('missing')).toBeUndefined();
  });
});
