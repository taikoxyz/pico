import { describe, expect, it } from 'vitest';
import { ZERO_SIG_HEX } from './constants.js';
import type {
  AcceptTopUpMessage,
  ChannelId,
  ChannelState,
  Hex,
  ProposeTopUpMessage,
  RejectTopUpMessage,
  SignedState,
  TopUpCompleteMessage,
  TopUpFeePolicy,
  TopUpOfferEnvelope,
} from './index.js';

const channelId = '0x000000000000000000000000000000000000000000000000000000000000beef' as ChannelId;
const offerId = '0x000000000000000000000000000000000000000000000000000000000000abcd' as Hex;
const txHash = '0x000000000000000000000000000000000000000000000000000000000000d00d' as Hex;

const newState: ChannelState = {
  channelId,
  version: 1n,
  balanceA: 10_000_000n,
  balanceB: 5_000_000n,
  htlcs: [],
  finalized: false,
};

const sig = { r: ZERO_SIG_HEX.slice(0, 66) as Hex, s: ZERO_SIG_HEX.slice(0, 66) as Hex, v: 27 };
const signedNewState: SignedState = { state: newState, sigA: sig, sigB: sig };

describe('topup-messages — shape', () => {
  it('TopUpFeePolicy carries flat + bps as bigints', () => {
    const policy: TopUpFeePolicy = { flat: 1n, bps: 10n };
    expect(policy.flat).toBe(1n);
    expect(policy.bps).toBe(10n);
  });

  it('TopUpOfferEnvelope holds every §8.6 field', () => {
    const envelope: TopUpOfferEnvelope = {
      kind: 'proposeTopUp',
      channelId,
      offerId,
      amount: 5_000_000n,
      prevStateVersion: 0n,
      newState,
      validUntil: 1_700_000_000n,
      feePolicy: null,
      minLifetime: null,
      maxInFlightHtlcs: 5,
      partialAccepted: false,
      prevSig: ZERO_SIG_HEX,
      newSig: ZERO_SIG_HEX,
    };
    expect(envelope.kind).toBe('proposeTopUp');
    expect(envelope.channelId).toBe(channelId);
    expect(envelope.amount).toBe(5_000_000n);
    expect(envelope.prevStateVersion).toBe(0n);
    expect(envelope.maxInFlightHtlcs).toBe(5);
    expect(envelope.partialAccepted).toBe(false);
  });

  it('ProposeTopUpMessage extends the envelope with a request id', () => {
    const msg: ProposeTopUpMessage = {
      id: 'req-1',
      kind: 'proposeTopUp',
      channelId,
      offerId,
      amount: 5_000_000n,
      prevStateVersion: 0n,
      newState,
      validUntil: 1_700_000_000n,
      feePolicy: { flat: 1n, bps: 10n },
      minLifetime: 3_600n,
      maxInFlightHtlcs: 5,
      partialAccepted: true,
      prevSig: ZERO_SIG_HEX,
      newSig: ZERO_SIG_HEX,
    };
    expect(msg.id).toBe('req-1');
    expect(msg.feePolicy?.flat).toBe(1n);
    expect(msg.minLifetime).toBe(3_600n);
  });

  it('AcceptTopUpMessage carries the dual-signed new state', () => {
    const msg: AcceptTopUpMessage = {
      id: 'req-1',
      kind: 'acceptTopUp',
      channelId,
      offerId,
      signedNewState,
    };
    expect(msg.kind).toBe('acceptTopUp');
    expect(msg.signedNewState.state.version).toBe(1n);
  });

  it('RejectTopUpMessage carries a reason string', () => {
    const msg: RejectTopUpMessage = {
      id: 'req-1',
      kind: 'rejectTopUp',
      channelId,
      offerId,
      reason: 'fee policy unacceptable',
    };
    expect(msg.kind).toBe('rejectTopUp');
    expect(msg.reason).toBe('fee policy unacceptable');
  });

  it('TopUpCompleteMessage carries the new on-chain version and tx hash', () => {
    const msg: TopUpCompleteMessage = {
      id: 'req-1',
      kind: 'topUpComplete',
      channelId,
      offerId,
      newVersion: 1n,
      txHash,
    };
    expect(msg.kind).toBe('topUpComplete');
    expect(msg.newVersion).toBe(1n);
    expect(msg.txHash).toBe(txHash);
  });
});
