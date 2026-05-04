import type { ChannelId, SignedState } from '@pico/protocol';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteWatchtowerStore, type WatchtowerObservation } from './storage.js';

const channelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as ChannelId;
const otherChannelId =
  '0x0000000000000000000000000000000000000000000000000000000000000002' as ChannelId;

function makeSignedState(version: bigint, id: ChannelId = channelId): SignedState {
  return {
    state: {
      channelId: id,
      version,
      balanceA: 100n,
      balanceB: 200n,
      htlcs: [],
      finalized: false,
    },
    sigA: { r: '0xaabbcc' as `0x${string}`, s: '0xddeeff' as `0x${string}`, v: 27 },
    sigB: { r: '0x112233' as `0x${string}`, s: '0x445566' as `0x${string}`, v: 28 },
  };
}

describe('SqliteWatchtowerStore', () => {
  let db: Database.Database;
  let store: SqliteWatchtowerStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SqliteWatchtowerStore(db);
    store.init();
  });

  afterEach(() => {
    store.close();
    if (db.open) db.close();
  });

  it('init() is idempotent', () => {
    expect(() => store.init()).not.toThrow();
    expect(() => store.init()).not.toThrow();
  });

  describe('signed states', () => {
    it('round-trips a signed state through loadAllSignedStates', () => {
      const signed = makeSignedState(7n);
      store.putSignedState(signed);
      const all = store.loadAllSignedStates();
      expect(all).toHaveLength(1);
      const loaded = all[0];
      if (!loaded) throw new Error('expected one loaded signed state');
      expect(loaded.state.channelId).toBe(channelId);
      expect(loaded.state.version).toBe(7n);
      expect(typeof loaded.state.version).toBe('bigint');
      expect(loaded.state.balanceA).toBe(100n);
      expect(loaded.state.balanceB).toBe(200n);
      expect(loaded.sigA).toEqual(signed.sigA);
      expect(loaded.sigB).toEqual(signed.sigB);
    });

    it('round-trips multiple channels independently', () => {
      store.putSignedState(makeSignedState(3n, channelId));
      store.putSignedState(makeSignedState(11n, otherChannelId));
      const all = store.loadAllSignedStates();
      expect(all).toHaveLength(2);
      const byId = new Map(all.map((s) => [s.state.channelId, s.state.version]));
      expect(byId.get(channelId)).toBe(3n);
      expect(byId.get(otherChannelId)).toBe(11n);
    });

    it('ignores older versions on putSignedState', () => {
      store.putSignedState(makeSignedState(10n));
      store.putSignedState(makeSignedState(5n));
      const all = store.loadAllSignedStates();
      expect(all).toHaveLength(1);
      expect(all[0]?.state.version).toBe(10n);
    });

    it('upgrades to a newer version on putSignedState', () => {
      store.putSignedState(makeSignedState(5n));
      store.putSignedState(makeSignedState(10n));
      const all = store.loadAllSignedStates();
      expect(all).toHaveLength(1);
      expect(all[0]?.state.version).toBe(10n);
    });
  });

  describe('observations', () => {
    function baseObs(): WatchtowerObservation {
      return {
        channelId,
        postedVersion: 5n,
        postedAtMs: 1_000,
        ourLatestVersion: 10n,
        actionTaken: 'penalize',
        reason: 'stale_state',
        createdAtMs: 1_500,
      };
    }

    it('records an observation and chains submitted -> included updates', () => {
      const id = store.recordObservation(baseObs());
      expect(typeof id).toBe('number');
      expect(id).toBeGreaterThan(0);

      store.markObservationSubmitted(id, '0xdeadbeef' as `0x${string}`, 2_000);
      store.markObservationIncluded(id, 3_000);

      const row = db
        .prepare(
          'SELECT id, channel_id, posted_version, posted_at_ms, our_latest_version, action_taken, reason, tx_hash, submitted_at_ms, included_at_ms, created_at_ms FROM watchtower_observations WHERE id = ?',
        )
        .get(id) as Record<string, unknown>;

      expect(row).toMatchObject({
        id,
        channel_id: channelId,
        posted_version: '5',
        posted_at_ms: 1_000,
        our_latest_version: '10',
        action_taken: 'penalize',
        reason: 'stale_state',
        tx_hash: '0xdeadbeef',
        submitted_at_ms: 2_000,
        included_at_ms: 3_000,
        created_at_ms: 1_500,
      });
    });

    it('allows recording noop observations without tx data', () => {
      const id = store.recordObservation({
        channelId,
        postedVersion: 5n,
        postedAtMs: 1_000,
        ourLatestVersion: 10n,
        actionTaken: 'noop',
        reason: 'already_penalized',
        createdAtMs: 1_500,
      });
      const row = db
        .prepare('SELECT action_taken, reason, tx_hash FROM watchtower_observations WHERE id = ?')
        .get(id) as Record<string, unknown>;
      expect(row.action_taken).toBe('noop');
      expect(row.reason).toBe('already_penalized');
      expect(row.tx_hash).toBeNull();
    });
  });

  describe('in-flight txs', () => {
    it('round-trips putInFlight / getInFlight / clearInFlight', () => {
      store.putInFlight({
        channelId,
        txHash: '0xabc' as `0x${string}`,
        submittedAtMs: 1_000,
        nonce: 7,
        maxFeePerGas: 1_234_567_890n,
        attempts: 1,
      });
      const row = store.getInFlight(channelId);
      expect(row).toBeDefined();
      expect(row?.channelId).toBe(channelId);
      expect(row?.txHash).toBe('0xabc');
      expect(row?.submittedAtMs).toBe(1_000);
      expect(row?.nonce).toBe(7);
      expect(row?.maxFeePerGas).toBe(1_234_567_890n);
      expect(typeof row?.maxFeePerGas).toBe('bigint');
      expect(row?.attempts).toBe(1);

      store.clearInFlight(channelId);
      expect(store.getInFlight(channelId)).toBeUndefined();
    });

    it('upserts on conflicting channelId', () => {
      store.putInFlight({
        channelId,
        txHash: '0xabc' as `0x${string}`,
        submittedAtMs: 1_000,
        nonce: 7,
        maxFeePerGas: 1n,
        attempts: 1,
      });
      store.putInFlight({
        channelId,
        txHash: '0xdef' as `0x${string}`,
        submittedAtMs: 2_000,
        nonce: 8,
        maxFeePerGas: 2n,
        attempts: 2,
      });
      const row = store.getInFlight(channelId);
      expect(row?.txHash).toBe('0xdef');
      expect(row?.attempts).toBe(2);
    });

    it('round-trips observationId and preserves it across upserts that omit it', () => {
      store.putInFlight({
        channelId,
        txHash: '0xabc' as `0x${string}`,
        submittedAtMs: 1_000,
        nonce: 7,
        maxFeePerGas: 1n,
        attempts: 1,
        observationId: 42,
      });
      expect(store.getInFlight(channelId)?.observationId).toBe(42);

      store.putInFlight({
        channelId,
        txHash: '0xdef' as `0x${string}`,
        submittedAtMs: 2_000,
        nonce: 7,
        maxFeePerGas: 2n,
        attempts: 2,
      });
      expect(store.getInFlight(channelId)?.observationId).toBe(42);
    });
  });

  describe('meta', () => {
    it('round-trips putMeta / getMeta', () => {
      store.putMeta('lastBlock', '12345');
      expect(store.getMeta('lastBlock')).toBe('12345');
    });

    it('overwrites existing meta values', () => {
      store.putMeta('lastBlock', '1');
      store.putMeta('lastBlock', '2');
      expect(store.getMeta('lastBlock')).toBe('2');
    });

    it('returns undefined for missing keys', () => {
      expect(store.getMeta('nope')).toBeUndefined();
    });
  });
});
