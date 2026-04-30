import { ANVIL_DEV_CHAIN_ID, CONTRACT_ADDRESSES, TAIKO_MAINNET_CHAIN_ID } from '@tainnel/protocol';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('uses mainnet defaults when env is empty (PaymentChannel is pre-set in CONTRACT_ADDRESSES)', () => {
    const cfg = loadConfig({});
    expect(cfg.port).toBe(3031);
    expect(cfg.logLevel).toBe('info');
    expect(cfg.mode).toBe('self-hosted');
    expect(cfg.chainId).toBe(TAIKO_MAINNET_CHAIN_ID);
    expect(cfg.paymentChannelAddress).toBe(
      CONTRACT_ADDRESSES[TAIKO_MAINNET_CHAIN_ID].PaymentChannel,
    );
    expect(cfg.penaltyThreshold).toBe(0.5);
    expect(cfg.schedulerIntervalMs).toBe(60_000);
    expect(cfg.confirmations).toBe(3);
    expect(cfg.rpcReconnectMaxBackoffMs).toBe(30_000);
    expect(cfg.interestedChannelIds).toBeUndefined();
  });

  it('honors explicit PAYMENT_CHANNEL_ADDRESS override on anvil chain', () => {
    const cfg = loadConfig({
      CHAIN_ID: String(ANVIL_DEV_CHAIN_ID),
      PAYMENT_CHANNEL_ADDRESS: '0x1111111111111111111111111111111111111111',
    });
    expect(cfg.chainId).toBe(ANVIL_DEV_CHAIN_ID);
    expect(cfg.paymentChannelAddress).toBe('0x1111111111111111111111111111111111111111');
  });

  it('throws on unsupported CHAIN_ID', () => {
    expect(() => loadConfig({ CHAIN_ID: '1' })).toThrow(/unsupported CHAIN_ID/);
  });

  it('overrides penaltyThreshold, schedulerIntervalMs, confirmations, rpcReconnectMaxBackoffMs from env', () => {
    const cfg = loadConfig({
      PENALTY_THRESHOLD: '0.9',
      SCHEDULER_INTERVAL_MS: '5000',
      CONFIRMATIONS: '12',
      RPC_RECONNECT_MAX_BACKOFF_MS: '60000',
    });
    expect(cfg.penaltyThreshold).toBe(0.9);
    expect(cfg.schedulerIntervalMs).toBe(5_000);
    expect(cfg.confirmations).toBe(12);
    expect(cfg.rpcReconnectMaxBackoffMs).toBe(60_000);
  });

  it('parses INTERESTED_CHANNEL_IDS as a comma-separated list with trimming', () => {
    const cfg = loadConfig({
      INTERESTED_CHANNEL_IDS: '0xabc, 0xdef ,0x123',
    });
    expect(cfg.interestedChannelIds).toEqual(['0xabc', '0xdef', '0x123']);
  });

  it('drops empty entries from INTERESTED_CHANNEL_IDS', () => {
    const cfg = loadConfig({
      INTERESTED_CHANNEL_IDS: '0xabc,, ,0xdef',
    });
    expect(cfg.interestedChannelIds).toEqual(['0xabc', '0xdef']);
  });

  it('selects service mode when MODE=service', () => {
    const cfg = loadConfig({ MODE: 'service' });
    expect(cfg.mode).toBe('service');
  });

  it('omits interestedChannelIds key when env unset', () => {
    const cfg = loadConfig({});
    expect(Object.prototype.hasOwnProperty.call(cfg, 'interestedChannelIds')).toBe(false);
  });
});
