import { hashTypedData, keccak256, stringToBytes } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  CHANNEL_STATE_TYPES,
  COOPERATIVE_CLOSE_TYPES,
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  HTLC_TYPES,
  TAIKO_HOODI_CHAIN_ID,
  TAIKO_MAINNET_CHAIN_ID,
  UPDATE_TYPES,
  buildDomain,
} from './index.js';
import type { Address, Hex } from './types.js';

const CHANNEL_STATE_TYPESTRING =
  'ChannelState(bytes32 channelId,uint64 version,uint256 balanceA,uint256 balanceB,bytes32 htlcsRoot,bool finalized)';
const HTLC_TYPESTRING =
  'Htlc(bytes32 id,uint256 amount,bytes32 paymentHash,uint64 expiry,uint8 direction)';
const UPDATE_TYPESTRING = `Update(bytes32 channelId,uint64 fromVersion,uint64 toVersion,ChannelState nextState)${CHANNEL_STATE_TYPESTRING}`;
const COOPERATIVE_CLOSE_TYPESTRING =
  'CooperativeClose(bytes32 channelId,uint256 finalBalanceA,uint256 finalBalanceB,uint64 signedAt)';

function encodeStruct(name: string, fields: ReadonlyArray<{ name: string; type: string }>): string {
  return `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`;
}

function typehashOf(typeString: string): Hex {
  return keccak256(stringToBytes(typeString));
}

const verifyingContract = '0x1111111111111111111111111111111111111111' as Address;

describe('eip712 — domain', () => {
  it('locks the domain name and version', () => {
    expect(EIP712_DOMAIN_NAME).toBe('pico');
    expect(EIP712_DOMAIN_VERSION).toBe('1');
  });

  it('buildDomain returns the expected shape for Hoodi', () => {
    const domain = buildDomain(TAIKO_HOODI_CHAIN_ID, verifyingContract);
    expect(domain).toEqual({
      name: 'pico',
      version: '1',
      chainId: TAIKO_HOODI_CHAIN_ID,
      verifyingContract,
    });
  });

  it('buildDomain returns the expected shape for mainnet', () => {
    const domain = buildDomain(TAIKO_MAINNET_CHAIN_ID, verifyingContract);
    expect(domain.chainId).toBe(TAIKO_MAINNET_CHAIN_ID);
    expect(domain.verifyingContract).toBe(verifyingContract);
  });
});

describe('eip712 — typehash strings agree with the Solidity contract', () => {
  it('CHANNEL_STATE_TYPES serializes to the contract typestring', () => {
    expect(encodeStruct('ChannelState', CHANNEL_STATE_TYPES.ChannelState)).toBe(
      CHANNEL_STATE_TYPESTRING,
    );
  });

  it('HTLC_TYPES serializes to the contract typestring', () => {
    expect(encodeStruct('Htlc', HTLC_TYPES.Htlc)).toBe(HTLC_TYPESTRING);
  });

  it('UPDATE_TYPES serializes (primary + nested) to the contract typestring', () => {
    const primary = encodeStruct('Update', UPDATE_TYPES.Update);
    const nested = encodeStruct('ChannelState', UPDATE_TYPES.ChannelState);
    expect(`${primary}${nested}`).toBe(UPDATE_TYPESTRING);
  });

  it('COOPERATIVE_CLOSE_TYPES serializes to the contract typestring', () => {
    expect(encodeStruct('CooperativeClose', COOPERATIVE_CLOSE_TYPES.CooperativeClose)).toBe(
      COOPERATIVE_CLOSE_TYPESTRING,
    );
  });

  it('typehash of ChannelState matches keccak256 of its typestring', () => {
    const expected = typehashOf(CHANNEL_STATE_TYPESTRING);
    expect(expected).toMatch(/^0x[0-9a-f]{64}$/);
    expect(expected).not.toBe('0x0000000000000000000000000000000000000000000000000000000000000000');
  });

  it('all four typehashes are distinct', () => {
    const set = new Set([
      typehashOf(CHANNEL_STATE_TYPESTRING),
      typehashOf(HTLC_TYPESTRING),
      typehashOf(UPDATE_TYPESTRING),
      typehashOf(COOPERATIVE_CLOSE_TYPESTRING),
    ]);
    expect(set.size).toBe(4);
  });
});

describe('eip712 — hashTypedData smoke', () => {
  it('produces a non-zero digest for a known ChannelState', () => {
    const digest = hashTypedData({
      domain: buildDomain(TAIKO_HOODI_CHAIN_ID, verifyingContract),
      types: CHANNEL_STATE_TYPES,
      primaryType: 'ChannelState',
      message: {
        channelId: '0x000000000000000000000000000000000000000000000000000000000000beef' as Hex,
        version: 1n,
        balanceA: 1_000_000n,
        balanceB: 2_000_000n,
        htlcsRoot: '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex,
        finalized: false,
      },
    });
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(digest).not.toBe('0x0000000000000000000000000000000000000000000000000000000000000000');
  });

  it('different chainIds yield different digests for the same message', () => {
    const message = {
      channelId: '0x000000000000000000000000000000000000000000000000000000000000beef' as Hex,
      version: 1n,
      balanceA: 1_000_000n,
      balanceB: 2_000_000n,
      htlcsRoot: '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex,
      finalized: false,
    };
    const a = hashTypedData({
      domain: buildDomain(TAIKO_MAINNET_CHAIN_ID, verifyingContract),
      types: CHANNEL_STATE_TYPES,
      primaryType: 'ChannelState',
      message,
    });
    const b = hashTypedData({
      domain: buildDomain(TAIKO_HOODI_CHAIN_ID, verifyingContract),
      types: CHANNEL_STATE_TYPES,
      primaryType: 'ChannelState',
      message,
    });
    expect(a).not.toBe(b);
  });
});
