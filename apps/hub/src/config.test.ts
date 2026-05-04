import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const ANVIL_ENV = {
  CHAIN_ID: '31337',
  PICO_DEV_ALLOW_ZERO_ADDRESS: 'true',
  HUB_PRIVATE_KEY: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
} as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('uses sensible anvil defaults when explicit dev env is set', () => {
    const cfg = loadConfig(ANVIL_ENV);
    expect(cfg.port).toBe(3030);
    expect(cfg.dbDriver).toBe('sqlite');
    expect(cfg.chainId).toBe(31337);
    // anvil is not mainnet — signed envelope opt-out is allowed
    expect(cfg.requireSignedEnvelope).toBe(false);
    expect(cfg.chainConfirmations).toBe(3);
    expect(cfg.chainPollingIntervalMs).toBe(4_000);
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

  it('respects DB_DRIVER=postgres', () => {
    const cfg = loadConfig({ ...ANVIL_ENV, DB_DRIVER: 'postgres' });
    expect(cfg.dbDriver).toBe('postgres');
    expect(cfg.dbUrl).toMatch(/^postgres:/);
  });

  it('parses fee env vars as bigint', () => {
    const cfg = loadConfig({
      ...ANVIL_ENV,
      HUB_FEE_BPS: '25',
      HUB_FEE_FLAT: '7',
    });
    expect(cfg.hubFeeBps).toBe(25n);
    expect(cfg.hubFeeFlat).toBe(7n);
  });

  it('rejects unsupported chain ids', () => {
    expect(() => loadConfig({ CHAIN_ID: '99999' } as NodeJS.ProcessEnv)).toThrow(/unsupported/);
  });

  it('enables signed-envelope auth by default on non-anvil chains', () => {
    const cfg = loadConfig({
      CHAIN_ID: '167000',
      HUB_PRIVATE_KEY: '0x1111111111111111111111111111111111111111111111111111111111111111',
      HUB_OPERATOR_TOKEN: 'test-token',
    });
    expect(cfg.requireSignedEnvelope).toBe(true);
  });

  it('rejects empty environment on mainnet (well-known dev key)', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/well-known development key/);
  });

  it('rejects mainnet without operator token', () => {
    expect(() =>
      loadConfig({
        CHAIN_ID: '167000',
        HUB_PRIVATE_KEY: '0x2222222222222222222222222222222222222222222222222222222222222222',
        HUB_REQUIRE_SIGNED_ENVELOPE: 'true',
      }),
    ).toThrow(/HUB_OPERATOR_TOKEN/);
  });

  it('rejects mainnet with HUB_REQUIRE_SIGNED_ENVELOPE=false', () => {
    expect(() =>
      loadConfig({
        CHAIN_ID: '167000',
        HUB_PRIVATE_KEY: '0x3333333333333333333333333333333333333333333333333333333333333333',
        HUB_REQUIRE_SIGNED_ENVELOPE: 'false',
        HUB_OPERATOR_TOKEN: 'tok',
      }),
    ).toThrow(/HUB_REQUIRE_SIGNED_ENVELOPE/);
  });

  it('accepts mainnet with explicit key + auth + token', () => {
    const cfg = loadConfig({
      CHAIN_ID: '167000',
      HUB_PRIVATE_KEY: '0x4444444444444444444444444444444444444444444444444444444444444444',
      HUB_REQUIRE_SIGNED_ENVELOPE: 'true',
      HUB_OPERATOR_TOKEN: 'tok',
    });
    expect(cfg.chainId).toBe(167000);
    expect(cfg.requireSignedEnvelope).toBe(true);
  });

  it('rejects zero-address contract on non-anvil unless override is set', () => {
    expect(() =>
      loadConfig({
        CHAIN_ID: '167009',
        HUB_PRIVATE_KEY: '0x5555555555555555555555555555555555555555555555555555555555555555',
      }),
    ).toThrow(/zero address|zero placeholders/);
  });
});
