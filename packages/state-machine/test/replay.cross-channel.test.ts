import type { ChannelState, Hex, Update } from '@inferenceroom/pico-protocol';
import { describe, expect, it } from 'vitest';
import { validateUpdate } from '../src/channel.js';
import type { StateMachineError } from '../src/errors.js';
import { hashUpdate } from '../src/signing.js';

const CHAIN_ID = 167009 as const;
const VERIFYING_CONTRACT = '0x0000000000000000000000000000000000000001' as const;

const channelA = '0x00000000000000000000000000000000000000000000000000000000000000aa' as const;
const channelB = '0x00000000000000000000000000000000000000000000000000000000000000bb' as const;

function emptyState(
  channelId: Hex,
  version: bigint,
  balanceA: bigint,
  balanceB: bigint,
): ChannelState {
  return {
    channelId,
    version,
    balanceA,
    balanceB,
    htlcs: [],
    htlcsCount: 0,
    htlcsTotalLocked: 0n,
    finalized: false,
  };
}

describe('Update wrapper — cross-channel replay protection (baseline H-01)', () => {
  it('validateUpdate rejects an Update whose wrapper channelId does not match prev.channelId', () => {
    const prevOnChannelA = emptyState(channelA, 1n, 100n, 50n);
    const updateForChannelB: Update = {
      channelId: channelB,
      fromVersion: 1n,
      toVersion: 2n,
      nextState: emptyState(channelB, 2n, 90n, 60n),
    };
    try {
      validateUpdate(prevOnChannelA, updateForChannelB);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as StateMachineError).code).toBe('CHANNEL_ID_MISMATCH');
    }
  });

  it('validateUpdate rejects an Update whose nested nextState.channelId disagrees with the wrapper', () => {
    // An attacker constructs a wrapper with channelId=A (matching the
    // target channel) but smuggles a nextState whose channelId points at
    // channel B. validateUpdate must reject this even though the outer
    // wrapper agrees with prev.
    const prevOnChannelA = emptyState(channelA, 1n, 100n, 50n);
    const smuggled: Update = {
      channelId: channelA,
      fromVersion: 1n,
      toVersion: 2n,
      nextState: emptyState(channelB, 2n, 90n, 60n),
    };
    try {
      validateUpdate(prevOnChannelA, smuggled);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as StateMachineError).code).toBe('CHANNEL_ID_MISMATCH');
    }
  });

  it('hashUpdate produces distinct digests for the same balances on different channelIds', () => {
    // The EIP-712 binding of channelId into the Update typehash is what
    // makes a signature on channel B unusable on channel A: even with
    // identical balances/versions, the digest the counterparty signed is
    // different, so signature verification on the wrong channel fails.
    const updateA: Update = {
      channelId: channelA,
      fromVersion: 1n,
      toVersion: 2n,
      nextState: emptyState(channelA, 2n, 90n, 60n),
    };
    const updateB: Update = {
      channelId: channelB,
      fromVersion: 1n,
      toVersion: 2n,
      nextState: emptyState(channelB, 2n, 90n, 60n),
    };
    const digestA = hashUpdate(updateA, CHAIN_ID, VERIFYING_CONTRACT);
    const digestB = hashUpdate(updateB, CHAIN_ID, VERIFYING_CONTRACT);
    expect(digestA).not.toBe(digestB);
  });

  it('hashUpdate also depends on the nested nextState.channelId field', () => {
    // Wrapper channelId matches prev, but nested state targets a different
    // channel. The Update digest differs from the well-formed Update for
    // channel A — counterparty signatures on the well-formed digest do not
    // validate against this smuggled wrapper.
    const wellFormedA: Update = {
      channelId: channelA,
      fromVersion: 1n,
      toVersion: 2n,
      nextState: emptyState(channelA, 2n, 90n, 60n),
    };
    const smuggled: Update = {
      channelId: channelA,
      fromVersion: 1n,
      toVersion: 2n,
      nextState: emptyState(channelB, 2n, 90n, 60n),
    };
    const digestWellFormed = hashUpdate(wellFormedA, CHAIN_ID, VERIFYING_CONTRACT);
    const digestSmuggled = hashUpdate(smuggled, CHAIN_ID, VERIFYING_CONTRACT);
    expect(digestWellFormed).not.toBe(digestSmuggled);
  });
});
