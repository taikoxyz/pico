import type { Address, ChainId, TokenInfo } from './types.js';

export const PROTOCOL_VERSION = '0.1.0' as const;

export const ETHEREUM_MAINNET_CHAIN_ID = 1 as const;
export const TAIKO_MAINNET_CHAIN_ID = 167000 as const;
export const TAIKO_HOODI_CHAIN_ID = 167009 as const;
export const ANVIL_DEV_CHAIN_ID = 31337 as const;

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

export const SUPPORTED_CHAIN_IDS: readonly ChainId[] = [
  TAIKO_MAINNET_CHAIN_ID,
  ETHEREUM_MAINNET_CHAIN_ID,
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
  [ETHEREUM_MAINNET_CHAIN_ID]: {
    // Pending deployment; set PAYMENT_CHANNEL_ADDRESS + ADJUDICATOR_ADDRESS env vars.
    PaymentChannel: ZERO_ADDRESS,
    Adjudicator: ZERO_ADDRESS,
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
  [ETHEREUM_MAINNET_CHAIN_ID]: {
    asset: 'USDC',
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address,
    decimals: 6,
    chainId: ETHEREUM_MAINNET_CHAIN_ID,
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
export const DEFAULT_HUB_FEE_BPS = 2n;
export const DEFAULT_HUB_FEE_FLAT = 1n;
export const MIN_CHANNEL_AMOUNT_USDC = 10_000_000n;
export const MIN_CHANNEL_AMOUNT_ETH = 10n ** 16n;

// Maximum number of in-flight HTLCs allowed on a single channel (§4.3).
export const MAX_HTLCS_PER_CHANNEL = 5;
// Aggregate in-flight HTLC value cap across all channels with the same
// counterparty, in USDC base units (= 100 USDC). See §4.3.
export const MAX_HTLC_VALUE_PER_COUNTERPARTY = 100_000_000n;
// Lower/upper bounds on how far in the future an HTLC's expiry may be set (§4.3).
export const MIN_HTLC_DURATION_MS = 15 * 60 * 1000;
export const MAX_HTLC_DURATION_MS = 2 * 60 * 60 * 1000;
// Required gap between outer (sender) and inner (hub) HTLC expiries (§4.3).
export const HTLC_TIMEOUT_DELTA_MS = 30 * 60 * 1000;
// Sentinel hex for an unsigned ECDSA signature slot (65 zero bytes); used for
// the implicit version-0 prevState in §8.3 and for opener-only initial states.
export const ZERO_SIG_HEX: `0x${string}` = `0x${'00'.repeat(65)}` as `0x${string}`;
