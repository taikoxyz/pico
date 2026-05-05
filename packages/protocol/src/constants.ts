import type { Address, ChainId, TokenInfo } from './types.js';

export const PROTOCOL_VERSION = '0.1.0' as const;

export const TAIKO_MAINNET_CHAIN_ID = 167000 as const;
export const TAIKO_HOODI_CHAIN_ID = 167009 as const;
export const ANVIL_DEV_CHAIN_ID = 31337 as const;

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

export const SUPPORTED_CHAIN_IDS: readonly ChainId[] = [
  TAIKO_MAINNET_CHAIN_ID,
  // TAIKO_HOODI_CHAIN_ID is excluded until contract and USDC addresses are deployed.
];

export const CONTRACT_ADDRESSES: Record<
  ChainId,
  Record<'PaymentChannel' | 'Adjudicator', Address>
> = {
  [TAIKO_MAINNET_CHAIN_ID]: {
    PaymentChannel: '0xCDEF7911155c8db64Ef810Ae8C538024550594D7' as Address,
    Adjudicator: '0xee660F9c471d833f092Bc79f5c8F9943469b0e05' as Address,
  },
  [TAIKO_HOODI_CHAIN_ID]: {
    PaymentChannel: ZERO_ADDRESS,
    Adjudicator: ZERO_ADDRESS,
  },
  [ANVIL_DEV_CHAIN_ID]: {
    PaymentChannel: ZERO_ADDRESS,
    Adjudicator: ZERO_ADDRESS,
  },
};

export const USDC_TOKENS: Record<ChainId, TokenInfo> = {
  [TAIKO_MAINNET_CHAIN_ID]: {
    asset: 'USDC',
    address: '0x07d83526730c7438048D55A4fc0b850e2aaB6f0b' as Address,
    decimals: 6,
    chainId: TAIKO_MAINNET_CHAIN_ID,
  },
  [TAIKO_HOODI_CHAIN_ID]: {
    asset: 'USDC',
    address: ZERO_ADDRESS,
    decimals: 6,
    chainId: TAIKO_HOODI_CHAIN_ID,
  },
  [ANVIL_DEV_CHAIN_ID]: {
    asset: 'USDC',
    address: ZERO_ADDRESS,
    decimals: 6,
    chainId: ANVIL_DEV_CHAIN_ID,
  },
};

export const DEFAULT_DISPUTE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_HTLC_EXPIRY_MS = 60 * 60 * 1000;
export const DEFAULT_HUB_FEE_BPS = 10n;
export const DEFAULT_HUB_FEE_FLAT = 1n;
export const MIN_CHANNEL_AMOUNT_USDC = 10_000_000n;
export const MIN_CHANNEL_AMOUNT_ETH = 10n ** 16n;
