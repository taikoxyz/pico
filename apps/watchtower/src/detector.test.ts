import type { SignedState } from '@tainnel/protocol';
import { describe, expect, it } from 'vitest';
import { FraudDetector } from './detector.js';

const channelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as const;

function makeSignedState(version: bigint): SignedState {
  const sig = {
    r: '0x00' as const,
    s: '0x00' as const,
    v: 27,
  };
  return {
    state: {
      channelId,
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
});
