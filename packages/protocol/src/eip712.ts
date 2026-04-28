import type { Address, ChainId } from './types.js';

export const EIP712_DOMAIN_NAME = 'tainnel';
export const EIP712_DOMAIN_VERSION = '1';

export interface Eip712Domain {
  readonly name: typeof EIP712_DOMAIN_NAME;
  readonly version: typeof EIP712_DOMAIN_VERSION;
  readonly chainId: ChainId;
  readonly verifyingContract: Address;
}

const CHANNEL_STATE_FIELDS = [
  { name: 'channelId', type: 'bytes32' },
  { name: 'version', type: 'uint64' },
  { name: 'balanceA', type: 'uint256' },
  { name: 'balanceB', type: 'uint256' },
  { name: 'htlcsRoot', type: 'bytes32' },
  { name: 'finalized', type: 'bool' },
] as const;

export const CHANNEL_STATE_TYPES = {
  ChannelState: CHANNEL_STATE_FIELDS,
} as const;

export const HTLC_TYPES = {
  Htlc: [
    { name: 'id', type: 'bytes32' },
    { name: 'amount', type: 'uint256' },
    { name: 'paymentHash', type: 'bytes32' },
    { name: 'expiry', type: 'uint64' },
    { name: 'direction', type: 'uint8' },
  ],
} as const;

export const UPDATE_TYPES = {
  Update: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'fromVersion', type: 'uint64' },
    { name: 'toVersion', type: 'uint64' },
    { name: 'nextState', type: 'ChannelState' },
  ],
  ChannelState: CHANNEL_STATE_FIELDS,
} as const;

export const COOPERATIVE_CLOSE_TYPES = {
  CooperativeClose: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'finalBalanceA', type: 'uint256' },
    { name: 'finalBalanceB', type: 'uint256' },
    { name: 'signedAt', type: 'uint64' },
  ],
} as const;

export function buildDomain(chainId: ChainId, verifyingContract: Address): Eip712Domain {
  return {
    name: EIP712_DOMAIN_NAME,
    version: EIP712_DOMAIN_VERSION,
    chainId,
    verifyingContract,
  };
}
