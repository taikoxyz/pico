import type { Address, Hex } from '@tainnel/protocol';
import { TAIKO_HOODI_CHAIN_ID, TAIKO_MAINNET_CHAIN_ID } from '@tainnel/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contractAddressFor, fetchHubInfo, usdcTokenFor } from './client.js';
import { CliError } from './errors.js';

const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const fakeAddress = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('contractAddressFor', () => {
  it('returns the protocol constant for mainnet', () => {
    const addr = contractAddressFor(TAIKO_MAINNET_CHAIN_ID, {});
    expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(addr).not.toBe('0x0000000000000000000000000000000000000000');
  });

  it('throws when contract is not deployed (Hoodi)', () => {
    expect(() => contractAddressFor(TAIKO_HOODI_CHAIN_ID, {})).toThrow(CliError);
  });

  it('respects TAINNEL_CONTRACT_ADDRESS override', () => {
    expect(
      contractAddressFor(TAIKO_HOODI_CHAIN_ID, { TAINNEL_CONTRACT_ADDRESS: fakeAddress }),
    ).toBe(fakeAddress);
  });

  it('rejects malformed override', () => {
    expect(() =>
      contractAddressFor(TAIKO_HOODI_CHAIN_ID, { TAINNEL_CONTRACT_ADDRESS: '0xnope' }),
    ).toThrow(CliError);
  });

  it('throws on unsupported chainId', () => {
    expect(() => contractAddressFor(1, {})).toThrow(CliError);
  });
});

describe('usdcTokenFor', () => {
  it('returns the protocol constant for mainnet', () => {
    expect(usdcTokenFor(TAIKO_MAINNET_CHAIN_ID, {})).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('throws when USDC is not deployed', () => {
    expect(() => usdcTokenFor(TAIKO_HOODI_CHAIN_ID, {})).toThrow(CliError);
  });

  it('respects TAINNEL_TOKEN_ADDRESS override', () => {
    expect(usdcTokenFor(TAIKO_HOODI_CHAIN_ID, { TAINNEL_TOKEN_ADDRESS: fakeAddress })).toBe(
      fakeAddress,
    );
  });
});

describe('fetchHubInfo', () => {
  it('returns the parsed body when the hub is healthy', async () => {
    const body = {
      status: 'ok',
      dbReady: true,
      chainReady: true,
      address: fakeAddress,
      chainId: TAIKO_HOODI_CHAIN_ID,
      version: '0.1.0',
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(body), { status: 200 }),
    );
    const info = await fetchHubInfo('http://localhost:3030');
    expect(info.address).toBe(fakeAddress);
    expect(info.chainId).toBe(TAIKO_HOODI_CHAIN_ID);
    expect(info.version).toBe('0.1.0');
  });

  it('throws CliError when the hub is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(fetchHubInfo('http://offline')).rejects.toBeInstanceOf(CliError);
  });

  it('throws CliError when the hub returns non-200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 503 }));
    await expect(fetchHubInfo('http://degraded')).rejects.toBeInstanceOf(CliError);
  });

  it('throws CliError when /health is missing required fields', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'ok', dbReady: true, chainReady: true }), {
        status: 200,
      }),
    );
    await expect(fetchHubInfo('http://oldhub')).rejects.toBeInstanceOf(CliError);
  });
});

describe('PK type', () => {
  it('placeholder for typecheck', () => {
    expect(PK as Hex).toMatch(/^0x/);
  });
});

describe('hubInfoFromEnv', () => {
  it('returns undefined when env vars are not set', async () => {
    const { hubInfoFromEnv } = await import('./client.js');
    expect(hubInfoFromEnv({})).toBeUndefined();
    expect(hubInfoFromEnv({ TAINNEL_HUB_ADDRESS: fakeAddress })).toBeUndefined();
    expect(hubInfoFromEnv({ TAINNEL_HUB_CHAIN_ID: '167009' })).toBeUndefined();
  });

  it('returns parsed info when both vars are set', async () => {
    const { hubInfoFromEnv } = await import('./client.js');
    const info = hubInfoFromEnv({
      TAINNEL_HUB_ADDRESS: fakeAddress,
      TAINNEL_HUB_CHAIN_ID: '167009',
      TAINNEL_HUB_VERSION: 't',
    });
    expect(info?.address).toBe(fakeAddress);
    expect(info?.chainId).toBe(167009);
    expect(info?.version).toBe('t');
  });

  it('throws on bad address', async () => {
    const { hubInfoFromEnv } = await import('./client.js');
    expect(() =>
      hubInfoFromEnv({ TAINNEL_HUB_ADDRESS: '0xnope', TAINNEL_HUB_CHAIN_ID: '167009' }),
    ).toThrow(CliError);
  });

  it('throws on bad chainId', async () => {
    const { hubInfoFromEnv } = await import('./client.js');
    expect(() =>
      hubInfoFromEnv({ TAINNEL_HUB_ADDRESS: fakeAddress, TAINNEL_HUB_CHAIN_ID: 'abc' }),
    ).toThrow(CliError);
  });
});

describe('buildClient', () => {
  it('builds a wired ChannelClient when env-pinned hub info is provided', async () => {
    const { startMockHub, TEST_KEYS } = await import('@tainnel/test-utils');
    const { buildClient } = await import('./client.js');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const verifyingContract = '0x1111111111111111111111111111111111111111';
    const hub = await startMockHub({
      hubPrivateKey: TEST_KEYS.hub.privateKey,
      chainId: 167009,
      verifyingContract,
    });
    const dir = mkdtempSync(join(tmpdir(), 'tcli-buildclient-'));
    try {
      const built = await buildClient({
        hubUrl: hub.url,
        storageDir: dir,
        env: {
          TAINNEL_PRIVATE_KEY: PK,
          TAINNEL_CHAIN_MODE: 'memory',
          TAINNEL_HUB_ADDRESS: TEST_KEYS.hub.address,
          TAINNEL_HUB_CHAIN_ID: '167009',
          TAINNEL_HUB_VERSION: 't',
          TAINNEL_CONTRACT_ADDRESS: verifyingContract,
          TAINNEL_TOKEN_ADDRESS: '0x07d83526730c7438048D55A4fc0b850e2aaB6f0b',
          TAINNEL_RPC_URL: 'http://unused',
        },
      });
      expect(built.client).toBeDefined();
      expect(built.hubInfo.address).toBe(TEST_KEYS.hub.address);
      expect(built.walletAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(built.storageDir).toBe(dir);
      await built.cleanup();
    } finally {
      await hub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
