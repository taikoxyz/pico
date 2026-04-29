import type { Address, Hex } from '@tainnel/protocol';
import { TAIKO_HOODI_CHAIN_ID, TAIKO_MAINNET_CHAIN_ID } from '@tainnel/protocol';
import { describe, expect, it } from 'vitest';
import { buildChainAdapter, chainById, defaultRpcUrl, readChainMode } from './chain.js';
import { CliError } from './errors.js';
import { InMemoryChainAdapter } from './in-memory-chain.js';

const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const userAddress = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;
const token = '0x07d83526730c7438048D55A4fc0b850e2aaB6f0b' as Address;

describe('readChainMode', () => {
  it('defaults to viem', () => {
    expect(readChainMode({})).toBe('viem');
  });
  it('returns memory when set', () => {
    expect(readChainMode({ TAINNEL_CHAIN_MODE: 'memory' })).toBe('memory');
  });
  it('returns viem when set explicitly', () => {
    expect(readChainMode({ TAINNEL_CHAIN_MODE: 'viem' })).toBe('viem');
  });
  it('throws on unknown value', () => {
    expect(() => readChainMode({ TAINNEL_CHAIN_MODE: 'evm' })).toThrow(CliError);
  });
});

describe('chainById', () => {
  it('resolves Taiko mainnet', () => {
    expect(chainById(TAIKO_MAINNET_CHAIN_ID).id).toBe(TAIKO_MAINNET_CHAIN_ID);
  });
  it('resolves Taiko Hoodi', () => {
    expect(chainById(TAIKO_HOODI_CHAIN_ID).id).toBe(TAIKO_HOODI_CHAIN_ID);
  });
  it('throws on unknown chain', () => {
    expect(() => chainById(1)).toThrow(CliError);
  });
});

describe('defaultRpcUrl', () => {
  it('returns mainnet RPC for mainnet chainId', () => {
    expect(defaultRpcUrl(TAIKO_MAINNET_CHAIN_ID)).toMatch(/rpc\.taiko\.xyz/);
  });
  it('returns Hoodi RPC for Hoodi chainId', () => {
    expect(defaultRpcUrl(TAIKO_HOODI_CHAIN_ID)).toMatch(/hoodi/);
  });
  it('throws on unknown chain', () => {
    expect(() => defaultRpcUrl(1)).toThrow(CliError);
  });
});

describe('buildChainAdapter', () => {
  it('returns InMemoryChainAdapter when mode=memory', () => {
    const adapter = buildChainAdapter({
      mode: 'memory',
      privateKey: PK,
      chainId: TAIKO_HOODI_CHAIN_ID,
      userAddress,
      token,
      rpcUrl: 'http://unused',
    });
    expect(adapter).toBeInstanceOf(InMemoryChainAdapter);
    expect(adapter.chainId).toBe(TAIKO_HOODI_CHAIN_ID);
  });

  it('returns a viem adapter when mode=viem', () => {
    const adapter = buildChainAdapter({
      mode: 'viem',
      privateKey: PK,
      chainId: TAIKO_HOODI_CHAIN_ID,
      userAddress,
      token,
      rpcUrl: 'http://localhost:8545',
    });
    expect(adapter).not.toBeInstanceOf(InMemoryChainAdapter);
    expect(adapter.chainId).toBe(TAIKO_HOODI_CHAIN_ID);
  });
});
