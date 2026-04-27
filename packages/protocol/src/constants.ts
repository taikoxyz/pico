import type { Address, ChainId, TokenInfo } from './types.js';

export const PROTOCOL_VERSION = '0.1.0' as const;

export const TAIKO_MAINNET_CHAIN_ID = 167000 as const;
export const TAIKO_HOODI_CHAIN_ID = 167009 as const;

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

export const SUPPORTED_CHAIN_IDS: readonly ChainId[] = [
  TAIKO_MAINNET_CHAIN_ID,
  TAIKO_HOODI_CHAIN_ID,
];

export const CONTRACT_ADDRESSES: Record<
  ChainId,
  Record<'PaymentChannel' | 'Adjudicator', Address>
> = {
  [TAIKO_MAINNET_CHAIN_ID]: {
    PaymentChannel: ZERO_ADDRESS,
    Adjudicator: ZERO_ADDRESS,
  },
  [TAIKO_HOODI_CHAIN_ID]: {
    PaymentChannel: ZERO_ADDRESS,
    Adjudicator: ZERO_ADDRESS,
  },
};

export const USDC_TOKENS: Record<ChainId, TokenInfo> = {
  [TAIKO_MAINNET_CHAIN_ID]: {
    asset: 'USDC',
    address: ZERO_ADDRESS,
    decimals: 6,
    chainId: TAIKO_MAINNET_CHAIN_ID,
  },
  [TAIKO_HOODI_CHAIN_ID]: {
    asset: 'USDC',
    address: ZERO_ADDRESS,
    decimals: 6,
    chainId: TAIKO_HOODI_CHAIN_ID,
  },
};

export const DEFAULT_DISPUTE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_HTLC_EXPIRY_MS = 60 * 60 * 1000;
export const DEFAULT_HUB_FEE_BPS = 10n;
export const DEFAULT_HUB_FEE_FLAT = 1n;
export const MIN_CHANNEL_AMOUNT_USDC = 1_000_000n;
export const MIN_CHANNEL_AMOUNT_ETH = 10n ** 16n;
