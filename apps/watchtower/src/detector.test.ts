import type { ChannelId, Hex, SignedState } from '@tainnel/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { FraudDetector } from './detector.js';
import type { PlainStateStore } from './storage.js';

const channelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as ChannelId;

function makeSignedState(version: bigint, ch: ChannelId = channelId): SignedState {
  return {
    state: {
      channelId: ch,
      version,
      balanceA: 0n,
      balanceB: 0n,
      htlcs: [],
      finalized: false,
    },
    sigA: { r: '0x00' as Hex, s: '0x00' as Hex, v: 27 },
    sigB: { r: '0x00' as Hex, s: '0x00' as Hex, v: 27 },
  };
}

describe('FraudDetector', () => {
  it('flags an old observed version as fraudulent', () => {
    const det = new FraudDetector();
    det.remember(makeSignedState(10n));
    expect(det.evaluate(channelId, 9n).fraudulent).toBe(true);
  });

  it('does not flag the latest known version', () => {
    const det = new FraudDetector();
    det.remember(makeSignedState(10n));
    expect(det.evaluate(channelId, 10n).fraudulent).toBe(false);
  });

  it('returns 0n latestKnownVersion for unknown channels', () => {
    const det = new FraudDetector();
    expect(det.evaluate(channelId, 5n)).toEqual({
      fraudulent: false,
      latestKnownVersion: 0n,
    });
  });
});

describe('FraudDetector.evaluateClosing', () => {
  const opts = { windowMs: 24 * 60 * 60 * 1000, threshold: 0.5 };
  let det: FraudDetector;

  beforeEach(() => {
    det = new FraudDetector();
  });

  it('returns noop when channel is unknown', () => {
    const r = det.evaluateClosing(channelId, 5n, 1_000, opts);
    expect(r.action).toBe('noop');
    if (r.action === 'noop') expect(r.reason).toContain('unknown');
  });

  it('returns noop when our state is older or equal', () => {
    det.remember(makeSignedState(5n));
    expect(det.evaluateClosing(channelId, 5n, 1_000, opts).action).toBe('noop');
    expect(det.evaluateClosing(channelId, 6n, 1_000, opts).action).toBe('noop');
  });

  it('returns penalize when our state is strictly newer', () => {
    det.remember(makeSignedState(10n));
    const r = det.evaluateClosing(channelId, 5n, 1_000, opts);
    expect(r.action).toBe('penalize');
    if (r.action === 'penalize') {
      expect(r.evidence.state.version).toBe(10n);
      expect(r.submitBy).toBe(1_000 + opts.windowMs * opts.threshold);
    }
  });

  it('threshold scales submitBy', () => {
    det.remember(makeSignedState(10n));
    const r1 = det.evaluateClosing(channelId, 5n, 0, { windowMs: 100_000, threshold: 0.25 });
    const r2 = det.evaluateClosing(channelId, 5n, 0, { windowMs: 100_000, threshold: 0.75 });
    if (r1.action !== 'penalize' || r2.action !== 'penalize') throw new Error('bad');
    expect(r1.submitBy).toBe(25_000);
    expect(r2.submitBy).toBe(75_000);
  });
});

describe('FraudDetector.hydrate', () => {
  it('seeds from a state store at startup', async () => {
    const channelB =
      '0x0000000000000000000000000000000000000000000000000000000000000002' as ChannelId;
    const map = new Map<ChannelId, SignedState>();
    map.set(channelId, makeSignedState(7n));
    map.set(channelB, makeSignedState(11n, channelB));
    const stateStore: PlainStateStore = {
      put: async (s) => {
        map.set(s.state.channelId, s);
      },
      latest: async (id) => map.get(id),
      list: async () => Array.from(map.values()),
    };
    const det = new FraudDetector({ stateStore });
    await det.hydrate();
    expect(det.knownVersion(channelId)).toBe(7n);
    expect(det.knownVersion(channelB)).toBe(11n);
    expect(det.channelsWatched()).toBe(2);
  });

  it('persists newly-remembered states through the store', () => {
    const stored: SignedState[] = [];
    const stateStore: PlainStateStore = {
      put: async (s) => {
        stored.push(s);
      },
      latest: async () => undefined,
      list: async () => [],
    };
    const det = new FraudDetector({ stateStore });
    det.remember(makeSignedState(3n));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.state.version).toBe(3n);
  });
});
