import { describe, expect, it } from 'vitest';
import {
  CONTRACT_ADDRESSES,
  DEFAULT_DISPUTE_WINDOW_MS,
  DEFAULT_HTLC_EXPIRY_MS,
  DEFAULT_HUB_FEE_BPS,
  DEFAULT_HUB_FEE_FLAT,
  MIN_CHANNEL_AMOUNT_ETH,
  MIN_CHANNEL_AMOUNT_USDC,
  NOSTR_EVENT_KINDS,
  NOSTR_KIND_RANGE,
  PROTOCOL_VERSION,
  SUPPORTED_CHAIN_IDS,
  TAIKO_HOODI_CHAIN_ID,
  TAIKO_MAINNET_CHAIN_ID,
  USDC_TOKENS,
  ZERO_ADDRESS,
} from './index.js';

describe('protocol decisions are pinned', () => {
  it('PROTOCOL_VERSION is semver', () => {
    expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('D1.1 dispute window is 24h', () => {
    expect(DEFAULT_DISPUTE_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
    expect(DEFAULT_DISPUTE_WINDOW_MS).toBe(86_400_000);
  });

  it('default HTLC expiry is 1h', () => {
    expect(DEFAULT_HTLC_EXPIRY_MS).toBe(60 * 60 * 1000);
    expect(DEFAULT_HTLC_EXPIRY_MS).toBe(3_600_000);
  });

  it('D1.4 minimum channel amount is 10 USDC (10_000_000 at 6 decimals)', () => {
    expect(MIN_CHANNEL_AMOUNT_USDC).toBe(10_000_000n);
  });

  it('minimum channel amount in ETH is 0.01 ETH (1e16 wei)', () => {
    expect(MIN_CHANNEL_AMOUNT_ETH).toBe(10_000_000_000_000_000n);
    expect(MIN_CHANNEL_AMOUNT_ETH).toBe(10n ** 16n);
  });

  it('D1.5 hub fee defaults are 10 bps + 1 unit flat', () => {
    expect(DEFAULT_HUB_FEE_BPS).toBe(10n);
    expect(DEFAULT_HUB_FEE_FLAT).toBe(1n);
  });
});

describe('chain ids and supported chains', () => {
  it('Taiko mainnet chain id is 167000', () => {
    expect(TAIKO_MAINNET_CHAIN_ID).toBe(167000);
  });

  it('Taiko Hoodi chain id is 167009', () => {
    expect(TAIKO_HOODI_CHAIN_ID).toBe(167009);
  });

  it('SUPPORTED_CHAIN_IDS contains mainnet; Hoodi excluded until deployed', () => {
    expect([...SUPPORTED_CHAIN_IDS]).toContain(TAIKO_MAINNET_CHAIN_ID);
    // TAIKO_HOODI_CHAIN_ID is excluded until contract and USDC addresses are deployed.
    expect(SUPPORTED_CHAIN_IDS).toHaveLength(1);
  });

  it('ZERO_ADDRESS is 20 zero bytes', () => {
    expect(ZERO_ADDRESS).toBe('0x0000000000000000000000000000000000000000');
    expect(ZERO_ADDRESS).toHaveLength(42);
  });
});

describe('contract addresses', () => {
  it('Taiko mainnet has populated PaymentChannel + Adjudicator addresses', () => {
    const addrs = CONTRACT_ADDRESSES[TAIKO_MAINNET_CHAIN_ID];
    expect(addrs.PaymentChannel).not.toBe(ZERO_ADDRESS);
    expect(addrs.Adjudicator).not.toBe(ZERO_ADDRESS);
    expect(addrs.PaymentChannel).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(addrs.Adjudicator).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('Hoodi addresses are placeholders pending deployment', () => {
    const addrs = CONTRACT_ADDRESSES[TAIKO_HOODI_CHAIN_ID];
    expect(addrs.PaymentChannel).toBe(ZERO_ADDRESS);
    expect(addrs.Adjudicator).toBe(ZERO_ADDRESS);
  });
});

describe('USDC tokens', () => {
  it('USDC has 6 decimals on every supported chain', () => {
    for (const chainId of SUPPORTED_CHAIN_IDS) {
      expect(USDC_TOKENS[chainId].decimals).toBe(6);
      expect(USDC_TOKENS[chainId].asset).toBe('USDC');
      expect(USDC_TOKENS[chainId].chainId).toBe(chainId);
    }
  });

  it('mainnet USDC address is populated', () => {
    expect(USDC_TOKENS[TAIKO_MAINNET_CHAIN_ID].address).not.toBe(ZERO_ADDRESS);
  });
});

describe('Nostr event kinds', () => {
  it('reserved range is 30401–30420', () => {
    expect(NOSTR_KIND_RANGE).toEqual({ min: 30401, max: 30420 });
  });

  it('every defined kind is unique and within the reserved range', () => {
    const values = Object.values(NOSTR_EVENT_KINDS);
    expect(new Set(values).size).toBe(values.length);
    for (const kind of values) {
      expect(kind).toBeGreaterThanOrEqual(NOSTR_KIND_RANGE.min);
      expect(kind).toBeLessThanOrEqual(NOSTR_KIND_RANGE.max);
    }
  });

  it('kinds are sorted ascending in declaration order', () => {
    const values = Object.values(NOSTR_EVENT_KINDS);
    const sorted = [...values].sort((a, b) => a - b);
    expect(values).toEqual(sorted);
  });
});
