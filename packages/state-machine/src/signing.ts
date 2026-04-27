import {
  type Address,
  CHANNEL_STATE_TYPES,
  type ChainId,
  type ChannelState,
  type Eip712Domain,
  type Hex,
  buildDomain,
} from '@tainnel/protocol';

export interface ChannelStateTypedData {
  readonly domain: Eip712Domain;
  readonly types: typeof CHANNEL_STATE_TYPES;
  readonly primaryType: 'ChannelState';
  readonly message: {
    readonly channelId: Hex;
    readonly version: bigint;
    readonly balanceA: bigint;
    readonly balanceB: bigint;
    readonly htlcsRoot: Hex;
    readonly finalized: boolean;
  };
}

export function buildChannelStateTypedData(
  state: ChannelState,
  chainId: ChainId,
  verifyingContract: Address,
  htlcsRoot: Hex,
): ChannelStateTypedData {
  return {
    domain: buildDomain(chainId, verifyingContract),
    types: CHANNEL_STATE_TYPES,
    primaryType: 'ChannelState',
    message: {
      channelId: state.channelId,
      version: state.version,
      balanceA: state.balanceA,
      balanceB: state.balanceB,
      htlcsRoot,
      finalized: state.finalized,
    },
  };
}
