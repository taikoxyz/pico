import {
  type ChannelState,
  type CooperativeClose,
  EMPTY_HTLCS_ROOT,
} from '@inferenceroom/pico-protocol';
import { decodeAbiParameters } from 'viem';
import { describe, expect, it } from 'vitest';
import { encodeChannelStateForOnChain, encodeCooperativeCloseForOnChain } from './chain-adapter.js';
import { channelStateSolidityStruct, cooperativeCloseSolidityStruct } from './contracts-abi.js';

const baseState: ChannelState = {
  channelId: '0x0000000000000000000000000000000000000000000000000000000000000001',
  version: 5n,
  balanceA: 100n,
  balanceB: 50n,
  htlcs: [],
  htlcsCount: 0,
  htlcsTotalLocked: 0n,
  finalized: true,
};

const baseClose: CooperativeClose = {
  channelId: baseState.channelId,
  version: 1n,
  finalBalanceA: 90n,
  finalBalanceB: 60n,
  signedAt: 1_777_777_777n,
  validUntil: 9_999_999_999n,
};

describe('encodeChannelStateForOnChain', () => {
  it('encodes a ChannelState as a single ABI tuple', () => {
    const encoded = encodeChannelStateForOnChain(baseState);
    const [decoded] = decodeAbiParameters(
      [{ type: 'tuple', components: [...channelStateSolidityStruct] }],
      encoded,
    );
    expect(decoded).toEqual({
      channelId: baseState.channelId,
      version: baseState.version,
      balanceA: baseState.balanceA,
      balanceB: baseState.balanceB,
      htlcsRoot: EMPTY_HTLCS_ROOT,
      htlcsCount: 0,
      htlcsTotalLocked: 0n,
      finalized: baseState.finalized,
    });
  });

  it('uses the computed htlcsRoot for non-empty htlcs', () => {
    const encoded = encodeChannelStateForOnChain({
      ...baseState,
      htlcs: [
        {
          id: '0x0000000000000000000000000000000000000000000000000000000000000abc',
          direction: 'AtoB',
          amount: 10n,
          paymentHash: '0xabababababababababababababababababababababababababababababababab',
          expiryMs: 1_800_000_000_000n,
        },
      ],
    });
    const [decoded] = decodeAbiParameters(
      [{ type: 'tuple', components: [...channelStateSolidityStruct] }],
      encoded,
    );
    expect((decoded as { htlcsRoot: string }).htlcsRoot).not.toBe(EMPTY_HTLCS_ROOT);
  });
});

describe('encodeCooperativeCloseForOnChain', () => {
  it('encodes a CooperativeClose as a single ABI tuple', () => {
    const encoded = encodeCooperativeCloseForOnChain(baseClose);
    const [decoded] = decodeAbiParameters(
      [{ type: 'tuple', components: [...cooperativeCloseSolidityStruct] }],
      encoded,
    );
    expect(decoded).toEqual(baseClose);
  });
});
