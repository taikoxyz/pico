import { ANVIL_DEV_CHAIN_ID, CONTRACT_ADDRESSES, TAIKO_MAINNET_CHAIN_ID } from '@tainnel/protocol';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const ANVIL_ENV = {
  CHAIN_ID: String(ANVIL_DEV_CHAIN_ID),
  PAYMENT_CHANNEL_ADDRESS: '0x1111111111111111111111111111111111111111',
  TAINNEL_DEV_ALLOW_ZERO_ADDRESS: 'true',
  WATCHTOWER_PRIVATE_KEY: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
} as NodeJS.ProcessEnv;

const MAINNET_ENV = {
  CHAIN_ID: String(TAIKO_MAINNET_CHAIN_ID),
  WATCHTOWER_PRIVATE_KEY: '0x4444444444444444444444444444444444444444444444444444444444444444',
} as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('uses anvil-friendly defaults when explicit dev env is set', () => {
    const cfg = loadConfig(ANVIL_ENV);
    expect(cfg.port).toBe(3031);
    expect(cfg.logLevel).toBe('info');
    expect(cfg.mode).toBe('self-hosted');
    expect(cfg.chainId).toBe(ANVIL_DEV_CHAIN_ID);
    expect(cfg.paymentChannelAddress).toBe('0x1111111111111111111111111111111111111111');
    expect(cfg.penaltyThreshold).toBe(0.5);
    expect(cfg.metricsBindAddr).toBe('127.0.0.1');
  });

  it('defaults metrics bind address to wildcard inside Kubernetes', () => {
    const cfg = loadConfig({
      ...ANVIL_ENV,
      KUBERNETES_SERVICE_HOST: '10.0.0.1',
    });
    expect(cfg.metricsBindAddr).toBe('::');
  });

  it('respects explicit METRICS_BIND_ADDR', () => {
    const cfg = loadConfig({
      ...ANVIL_ENV,
      KUBERNETES_SERVICE_HOST: '10.0.0.1',
      METRICS_BIND_ADDR: '0.0.0.0',
    });
    expect(cfg.metricsBindAddr).toBe('0.0.0.0');
  });

  it('uses mainnet defaults with explicit private key', () => {
    const cfg = loadConfig(MAINNET_ENV);
    expect(cfg.chainId).toBe(TAIKO_MAINNET_CHAIN_ID);
    expect(cfg.paymentChannelAddress).toBe(
      CONTRACT_ADDRESSES[TAIKO_MAINNET_CHAIN_ID].PaymentChannel,
    );
  });

  it('rejects empty environment on mainnet (well-known dev key)', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/well-known development key/);
  });

  it('rejects MODE=service until implemented', () => {
    expect(() => loadConfig({ ...MAINNET_ENV, MODE: 'service' })).toThrow(
      /service.*not implemented/,
    );
  });

  it('rejects unsupported chain ids', () => {
    expect(() => loadConfig({ CHAIN_ID: '1' })).toThrow(/unsupported CHAIN_ID/);
  });

  it('rejects negative or out-of-range PENALTY_THRESHOLD', () => {
    expect(() => loadConfig({ ...MAINNET_ENV, PENALTY_THRESHOLD: '1.5' })).toThrow(
      /PENALTY_THRESHOLD/,
    );
    expect(() => loadConfig({ ...MAINNET_ENV, PENALTY_THRESHOLD: '-0.1' })).toThrow(
      /PENALTY_THRESHOLD/,
    );
  });

  it('rejects NaN or non-positive scheduler interval', () => {
    expect(() => loadConfig({ ...MAINNET_ENV, SCHEDULER_INTERVAL_MS: 'oops' })).toThrow(
      /SCHEDULER_INTERVAL_MS/,
    );
    expect(() => loadConfig({ ...MAINNET_ENV, SCHEDULER_INTERVAL_MS: '-1' })).toThrow(
      /SCHEDULER_INTERVAL_MS/,
    );
  });

  it('rejects malformed private key', () => {
    expect(() => loadConfig({ ...MAINNET_ENV, WATCHTOWER_PRIVATE_KEY: '0xnothex' })).toThrow(
      /WATCHTOWER_PRIVATE_KEY.*hex/,
    );
  });

  it('rejects malformed PAYMENT_CHANNEL_ADDRESS', () => {
    expect(() => loadConfig({ ...MAINNET_ENV, PAYMENT_CHANNEL_ADDRESS: '0xnope' })).toThrow(
      /valid hex address/,
    );
  });

  it('rejects invalid bytes32 in INTERESTED_CHANNEL_IDS', () => {
    expect(() => loadConfig({ ...MAINNET_ENV, INTERESTED_CHANNEL_IDS: '0xabc, 0xdef' })).toThrow(
      /invalid bytes32/,
    );
  });

  it('parses INTERESTED_CHANNEL_IDS as a comma-separated list of bytes32 values', () => {
    const cfg = loadConfig({
      ...MAINNET_ENV,
      INTERESTED_CHANNEL_IDS: `0x${'a'.repeat(64)}, 0x${'b'.repeat(64)}`,
    });
    expect(cfg.interestedChannelIds).toEqual([`0x${'a'.repeat(64)}`, `0x${'b'.repeat(64)}`]);
  });

  it('overrides numeric env vars from environment', () => {
    const cfg = loadConfig({
      ...MAINNET_ENV,
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

  it('omits interestedChannelIds key when env unset', () => {
    const cfg = loadConfig(MAINNET_ENV);
    expect(Object.prototype.hasOwnProperty.call(cfg, 'interestedChannelIds')).toBe(false);
  });
});
