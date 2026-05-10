import type { ChannelState, Htlc } from '@inferenceroom/pico-protocol';
import { describe, expect, it } from 'vitest';
import { StateMachineError } from './errors.js';
import { predictTopUpState } from './topup.js';

const channelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as const;

function makeState(
  balanceA: bigint,
  balanceB: bigint,
  htlcs: readonly Htlc[] = [],
  finalized = false,
  version = 1n,
): ChannelState {
  return {
    channelId,
    version,
    balanceA,
    balanceB,
    htlcs,
    finalized,
  };
}

function makeHtlc(): Htlc {
  return {
    id: '0x0000000000000000000000000000000000000000000000000000000000000001',
    direction: 'AtoB',
    amount: 100n,
    paymentHash: '0xabababababababababababababababababababababababababababababababab',
    expiryMs: 1_800_000_000_000n,
  };
}

describe('predictTopUpState', () => {
  it('side=A: increments version, only balanceA grows by amount', () => {
    const prev = makeState(1_000n, 2_000n);
    const next = predictTopUpState(prev, 'A', 500n);
    expect(next.version).toBe(prev.version + 1n);
    expect(next.balanceA).toBe(1_500n);
    expect(next.balanceB).toBe(2_000n);
    expect(next.channelId).toBe(channelId);
    expect(next.htlcs).toEqual([]);
    expect(next.finalized).toBe(false);
  });

  it('side=B: increments version, only balanceB grows by amount', () => {
    const prev = makeState(1_000n, 2_000n, [], false, 7n);
    const next = predictTopUpState(prev, 'B', 250n);
    expect(next.version).toBe(8n);
    expect(next.balanceA).toBe(1_000n);
    expect(next.balanceB).toBe(2_250n);
  });

  it('rejects amount=0 with ZERO_AMOUNT', () => {
    const prev = makeState(1_000n, 2_000n);
    try {
      predictTopUpState(prev, 'A', 0n);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StateMachineError);
      expect((err as StateMachineError).code).toBe('ZERO_AMOUNT');
    }
  });

  it('rejects negative amount with ZERO_AMOUNT', () => {
    const prev = makeState(1_000n, 2_000n);
    try {
      predictTopUpState(prev, 'A', -1n);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StateMachineError);
      expect((err as StateMachineError).code).toBe('ZERO_AMOUNT');
    }
  });

  it('rejects prev with in-flight htlcs with HTLCS_IN_FLIGHT', () => {
    const prev = makeState(1_000n, 2_000n, [makeHtlc()]);
    try {
      predictTopUpState(prev, 'A', 100n);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StateMachineError);
      expect((err as StateMachineError).code).toBe('HTLCS_IN_FLIGHT');
    }
  });

  it('rejects prev finalized with STATE_FINALIZED', () => {
    const prev = makeState(1_000n, 2_000n, [], true);
    try {
      predictTopUpState(prev, 'B', 100n);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StateMachineError);
      expect((err as StateMachineError).code).toBe('STATE_FINALIZED');
    }
  });
});
