import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('uses sensible defaults when no env is set', () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    expect(cfg.port).toBe(3030);
    expect(cfg.dbDriver).toBe('sqlite');
    expect(cfg.chainId).toBe(167000);
    expect(cfg.requireSignedEnvelope).toBe(false);
    expect(cfg.chainConfirmations).toBe(3);
    expect(cfg.chainPollingIntervalMs).toBe(4_000);
  });

  it('respects DB_DRIVER=postgres', () => {
    const cfg = loadConfig({ DB_DRIVER: 'postgres' } as NodeJS.ProcessEnv);
    expect(cfg.dbDriver).toBe('postgres');
    expect(cfg.dbUrl).toMatch(/^postgres:/);
  });

  it('parses fee env vars as bigint', () => {
    const cfg = loadConfig({
      HUB_FEE_BPS: '25',
      HUB_FEE_FLAT: '7',
    } as NodeJS.ProcessEnv);
    expect(cfg.hubFeeBps).toBe(25n);
    expect(cfg.hubFeeFlat).toBe(7n);
  });

  it('rejects unsupported chain ids', () => {
    expect(() => loadConfig({ CHAIN_ID: '99999' } as NodeJS.ProcessEnv)).toThrow(/unsupported/);
  });

  it('enables signed-envelope auth when explicitly requested', () => {
    const cfg = loadConfig({ HUB_REQUIRE_SIGNED_ENVELOPE: 'true' } as NodeJS.ProcessEnv);
    expect(cfg.requireSignedEnvelope).toBe(true);
  });
});
