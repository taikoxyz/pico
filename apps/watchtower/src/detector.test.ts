import type { ChannelId, SignedState } from '@tainnel/protocol';
import { describe, expect, it } from 'vitest';
import { FraudDetector } from './detector.js';

const channelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as const;
const otherChannelId =
  '0x0000000000000000000000000000000000000000000000000000000000000002' as ChannelId;

function makeSignedState(version: bigint, id: ChannelId = channelId): SignedState {
  const sig = {
    r: '0x00' as const,
    s: '0x00' as const,
    v: 27,
  };
  return {
    state: {
      channelId: id,
      version,
      balanceA: 0n,
      balanceB: 0n,
      htlcs: [],
      finalized: false,
    },
    sigA: sig,
    sigB: sig,
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

  describe('hydrate', () => {
    it('sets getLatest to the highest-version state across multiple inputs', () => {
      const det = new FraudDetector();
      det.hydrate([
        makeSignedState(3n),
        makeSignedState(7n),
        makeSignedState(5n),
        makeSignedState(2n),
      ]);
      expect(det.getLatest(channelId)?.state.version).toBe(7n);
    });

    it('keeps the highest-version state per channel independently', () => {
      const det = new FraudDetector();
      det.hydrate([
        makeSignedState(3n, channelId),
        makeSignedState(11n, otherChannelId),
        makeSignedState(8n, channelId),
        makeSignedState(4n, otherChannelId),
      ]);
      expect(det.getLatest(channelId)?.state.version).toBe(8n);
      expect(det.getLatest(otherChannelId)?.state.version).toBe(11n);
    });
  });

  describe('evaluateClosing', () => {
    it('returns noop unknown_channel when nothing is known', () => {
      const det = new FraudDetector();
      const res = det.evaluateClosing({
        channelId,
        postedVersion: 5n,
        postedAtMs: 1_000,
        windowMs: 86_400_000,
      });
      expect(res).toEqual({
        action: 'noop',
        reason: 'unknown_channel',
        latestKnownVersion: 0n,
      });
    });

    it('returns noop not_stale when posted version equals known', () => {
      const det = new FraudDetector();
      det.remember(makeSignedState(10n));
      const res = det.evaluateClosing({
        channelId,
        postedVersion: 10n,
        postedAtMs: 1_000,
        windowMs: 86_400_000,
      });
      expect(res).toEqual({
        action: 'noop',
        reason: 'not_stale',
        latestKnownVersion: 10n,
      });
    });

    it('returns noop not_stale when posted version exceeds known', () => {
      const det = new FraudDetector();
      det.remember(makeSignedState(10n));
      const res = det.evaluateClosing({
        channelId,
        postedVersion: 12n,
        postedAtMs: 1_000,
        windowMs: 86_400_000,
      });
      expect(res.action).toBe('noop');
      if (res.action === 'noop') {
        expect(res.reason).toBe('not_stale');
        expect(res.latestKnownVersion).toBe(10n);
      }
    });

    it('returns noop already_penalized regardless of versions', () => {
      const det = new FraudDetector();
      det.remember(makeSignedState(20n));
      const res = det.evaluateClosing({
        channelId,
        postedVersion: 5n,
        postedAtMs: 1_000,
        windowMs: 86_400_000,
        alreadyPenalized: true,
      });
      expect(res).toEqual({
        action: 'noop',
        reason: 'already_penalized',
        latestKnownVersion: 20n,
      });
    });

    it('returns already_penalized even when channel is unknown', () => {
      const det = new FraudDetector();
      const res = det.evaluateClosing({
        channelId,
        postedVersion: 5n,
        postedAtMs: 1_000,
        windowMs: 86_400_000,
        alreadyPenalized: true,
      });
      expect(res).toEqual({
        action: 'noop',
        reason: 'already_penalized',
        latestKnownVersion: 0n,
      });
    });

    it('returns penalize with default thresholdRatio of 0.5', () => {
      const det = new FraudDetector();
      const evidence = makeSignedState(20n);
      det.remember(evidence);
      const postedAtMs = 1_000;
      const windowMs = 86_400_000;
      const res = det.evaluateClosing({
        channelId,
        postedVersion: 5n,
        postedAtMs,
        windowMs,
      });
      expect(res.action).toBe('penalize');
      if (res.action === 'penalize') {
        expect(res.evidence).toBe(evidence);
        expect(res.latestKnownVersion).toBe(20n);
        expect(res.submitByMs).toBe(postedAtMs + Math.floor(windowMs * 0.5));
      }
    });

    it('honours a custom thresholdRatio of 0.25', () => {
      const det = new FraudDetector();
      det.remember(makeSignedState(20n));
      const postedAtMs = 1_000;
      const windowMs = 86_400_000;
      const res = det.evaluateClosing({
        channelId,
        postedVersion: 5n,
        postedAtMs,
        windowMs,
        thresholdRatio: 0.25,
      });
      expect(res.action).toBe('penalize');
      if (res.action === 'penalize') {
        expect(res.submitByMs).toBe(postedAtMs + Math.floor(windowMs * 0.25));
      }
    });

    it('honours a custom thresholdRatio of 0.75', () => {
      const det = new FraudDetector();
      det.remember(makeSignedState(20n));
      const postedAtMs = 1_000;
      const windowMs = 86_400_000;
      const res = det.evaluateClosing({
        channelId,
        postedVersion: 5n,
        postedAtMs,
        windowMs,
        thresholdRatio: 0.75,
      });
      expect(res.action).toBe('penalize');
      if (res.action === 'penalize') {
        expect(res.submitByMs).toBe(postedAtMs + Math.floor(windowMs * 0.75));
      }
    });
  });
});
