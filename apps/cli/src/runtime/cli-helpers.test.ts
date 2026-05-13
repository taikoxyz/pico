import {
  TAIKO_HOODI_CHAIN_ID,
  TAIKO_MAINNET_CHAIN_ID,
  ZERO_ADDRESS,
} from '@inferenceroom/pico-protocol';
import type { Address, PublicClient } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_HUB_URL,
  describeCliError,
  formatCliError,
  parseAmount,
  readTokenDecimals,
  resolveHubUrl,
  warnLocalhostHubOnMainnet,
} from './cli-helpers.js';

class Stub {
  buf = '';
  write(s: string) {
    this.buf += s;
  }
}

describe('resolveHubUrl', () => {
  it('uses explicit --via when set to a non-legacy value', () => {
    const url = resolveHubUrl({
      via: 'wss://custom.example/ws',
      env: {},
      chainId: TAIKO_MAINNET_CHAIN_ID,
    });
    expect(url).toBe('wss://custom.example/ws');
  });

  it('treats the Commander default ws://127.0.0.1:9050 as "unset" and falls through', () => {
    const url = resolveHubUrl({
      via: 'ws://127.0.0.1:9050',
      env: {},
      chainId: TAIKO_MAINNET_CHAIN_ID,
    });
    expect(url).toBe(DEFAULT_HUB_URL[TAIKO_MAINNET_CHAIN_ID]);
  });

  it('prefers PICO_HUB_URL env over the chain default', () => {
    const url = resolveHubUrl({
      via: 'ws://127.0.0.1:9050',
      env: { PICO_HUB_URL: 'wss://env.example/ws' },
      chainId: TAIKO_MAINNET_CHAIN_ID,
    });
    expect(url).toBe('wss://env.example/ws');
  });

  it('returns the per-chain default for hoodi', () => {
    const url = resolveHubUrl({ via: undefined, env: {}, chainId: TAIKO_HOODI_CHAIN_ID });
    expect(url).toBe(DEFAULT_HUB_URL[TAIKO_HOODI_CHAIN_ID]);
  });
});

describe('warnLocalhostHubOnMainnet', () => {
  it('warns when --via is localhost and chain is mainnet', () => {
    const stderr = new Stub();
    warnLocalhostHubOnMainnet({
      hubUrl: 'ws://127.0.0.1:9050',
      chainId: TAIKO_MAINNET_CHAIN_ID,
      stderr,
    });
    expect(stderr.buf).toContain('warning');
    expect(stderr.buf).toContain('Taiko mainnet');
  });

  it('does not warn when chain is not mainnet', () => {
    const stderr = new Stub();
    warnLocalhostHubOnMainnet({
      hubUrl: 'ws://127.0.0.1:9050',
      chainId: TAIKO_HOODI_CHAIN_ID,
      stderr,
    });
    expect(stderr.buf).toBe('');
  });

  it('does not warn for a non-localhost URL even on mainnet', () => {
    const stderr = new Stub();
    warnLocalhostHubOnMainnet({
      hubUrl: 'wss://hub.pico.taiko.xyz/ws',
      chainId: TAIKO_MAINNET_CHAIN_ID,
      stderr,
    });
    expect(stderr.buf).toBe('');
  });
});

describe('parseAmount', () => {
  it('scales decimal --amount by token decimals', () => {
    expect(parseAmount({ amount: '10', decimals: 18, rawMode: false })).toBe(10n ** 19n);
    expect(parseAmount({ amount: '10.5', decimals: 6, rawMode: false })).toBe(10_500_000n);
  });

  it('passes through raw integer when rawMode=true', () => {
    expect(parseAmount({ amount: '10000000000000000000', decimals: 18, rawMode: true })).toBe(
      10n ** 19n,
    );
  });

  it('rejects a decimal value in raw mode', () => {
    expect(() => parseAmount({ amount: '10.5', decimals: 18, rawMode: true })).toThrow(/raw mode/);
  });

  it('rejects a non-numeric value in raw mode', () => {
    expect(() => parseAmount({ amount: '10x', decimals: 18, rawMode: true })).toThrow(/raw mode/);
  });
});

describe('describeCliError / formatCliError', () => {
  it('tags viem ContractFunctionExecutionError as chain with decoded reason', () => {
    const err = {
      name: 'ContractFunctionExecutionError',
      shortMessage: 'short',
      metaMessages: ['Error: ERC20InsufficientAllowance(...)'],
    };
    const { tag, message } = describeCliError(err);
    expect(tag).toBe('chain');
    expect(message).toContain('ERC20InsufficientAllowance');
    expect(formatCliError(err)).toMatch(/^chain error: /);
  });

  it('tags CallExecutionError as chain', () => {
    const err = { name: 'CallExecutionError', shortMessage: 'simulation failed' };
    expect(describeCliError(err).tag).toBe('chain');
  });

  it('tags transport timeouts as hub', () => {
    const err = new Error("transport request 'subscribe' timed out after 10000ms");
    expect(describeCliError(err).tag).toBe('hub');
  });

  it('tags raw WebSocket errors as ws', () => {
    const err = new Error('WebSocket error');
    expect(describeCliError(err).tag).toBe('ws');
  });

  it('tags unknown errors as cli', () => {
    expect(describeCliError(new Error('boom')).tag).toBe('cli');
  });
});

describe('readTokenDecimals', () => {
  it('returns 18 for the native-ETH sentinel without calling the contract', async () => {
    const readContract = vi.fn();
    const client = { readContract } as unknown as PublicClient;
    expect(await readTokenDecimals({ client, token: ZERO_ADDRESS })).toBe(18);
    expect(readContract).not.toHaveBeenCalled();
  });

  it('reads decimals() from the token contract for ERC-20s', async () => {
    const readContract = vi.fn().mockResolvedValue(6);
    const client = { readContract } as unknown as PublicClient;
    const token = '0x07d83526730c7438048D55A4fc0b850e2aaB6f0b' as Address;
    expect(await readTokenDecimals({ client, token })).toBe(6);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: token, functionName: 'decimals' }),
    );
  });
});
