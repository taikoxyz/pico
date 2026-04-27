import type { Address, ChainId } from './types.js';

export const EIP712_DOMAIN_NAME = 'tainnel';
export const EIP712_DOMAIN_VERSION = '1';

export interface Eip712Domain {
  readonly name: typeof EIP712_DOMAIN_NAME;
  readonly version: typeof EIP712_DOMAIN_VERSION;
  readonly chainId: ChainId;
  readonly verifyingContract: Address;
}

export const CHANNEL_STATE_TYPES = {
  ChannelState: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'version', type: 'uint64' },
    { name: 'balanceA', type: 'uint256' },
    { name: 'balanceB', type: 'uint256' },
    { name: 'htlcsRoot', type: 'bytes32' },
    { name: 'finalized', type: 'bool' },
  ],
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

export function buildDomain(chainId: ChainId, verifyingContract: Address): Eip712Domain {
  return {
    name: EIP712_DOMAIN_NAME,
    version: EIP712_DOMAIN_VERSION,
    chainId,
    verifyingContract,
  };
}
