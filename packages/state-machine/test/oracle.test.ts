import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Address,
  type ChannelState,
  type CooperativeClose,
  type Hex,
  type Htlc,
  type Update,
  htlcMerkleRoot,
} from '@inferenceroom/pico-protocol';
import { describe, expect, it } from 'vitest';
import { hashChannelState, hashCooperativeClose, hashHtlc, hashUpdate } from '../src/signing.js';

interface RawHtlc {
  id: Hex;
  direction: 'AtoB' | 'BtoA';
  amount: string;
  paymentHash: Hex;
  expiryMs: string;
}
interface RawChannelState {
  channelId: Hex;
  version: string;
  balanceA: string;
  balanceB: string;
  htlcs: RawHtlc[];
  htlcsCount: number;
  htlcsTotalLocked: string;
  finalized: boolean;
}
interface RawUpdate {
  channelId: Hex;
  fromVersion: string;
  toVersion: string;
  nextState: RawChannelState;
}
interface RawCooperativeClose {
  channelId: Hex;
  version: string;
  finalBalanceA: string;
  finalBalanceB: string;
  signedAt: string;
  validUntil: string;
}

interface Oracle {
  domain: { chainId: 167000 | 167009; verifyingContract: Address };
  channelState: { input: RawChannelState; digest: Hex; htlcsRoot: Hex }[];
  htlc: { input: RawHtlc; digest: Hex }[];
  update: { input: RawUpdate; digest: Hex }[];
  cooperativeClose: { input: RawCooperativeClose; digest: Hex }[];
}

function reviveHtlc(raw: RawHtlc): Htlc {
  return {
    id: raw.id,
    direction: raw.direction,
    amount: BigInt(raw.amount),
    paymentHash: raw.paymentHash,
    expiryMs: BigInt(raw.expiryMs),
  };
}

function reviveChannelState(raw: RawChannelState): ChannelState {
  return {
    channelId: raw.channelId,
    version: BigInt(raw.version),
    balanceA: BigInt(raw.balanceA),
    balanceB: BigInt(raw.balanceB),
    htlcs: raw.htlcs.map(reviveHtlc),
    htlcsCount: raw.htlcsCount,
    htlcsTotalLocked: BigInt(raw.htlcsTotalLocked),
    finalized: raw.finalized,
  };
}

function reviveUpdate(raw: RawUpdate): Update {
  return {
    channelId: raw.channelId,
    fromVersion: BigInt(raw.fromVersion),
    toVersion: BigInt(raw.toVersion),
    nextState: reviveChannelState(raw.nextState),
  };
}

function reviveCooperativeClose(raw: RawCooperativeClose): CooperativeClose {
  return {
    channelId: raw.channelId,
    version: BigInt(raw.version),
    finalBalanceA: BigInt(raw.finalBalanceA),
    finalBalanceB: BigInt(raw.finalBalanceB),
    signedAt: BigInt(raw.signedAt),
    validUntil: BigInt(raw.validUntil),
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const oraclePath = join(here, 'fixtures', 'oracle.json');
const oracle = JSON.parse(readFileSync(oraclePath, 'utf-8')) as Oracle;

describe('oracle.json — cross-package consistency fixture', () => {
  it('has the expected shape and population', () => {
    expect(oracle.domain.chainId).toBe(167009);
    expect(oracle.domain.verifyingContract).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(oracle.channelState.length).toBeGreaterThanOrEqual(10);
    expect(oracle.htlc.length).toBeGreaterThanOrEqual(10);
    expect(oracle.update.length).toBeGreaterThanOrEqual(10);
    expect(oracle.cooperativeClose.length).toBeGreaterThanOrEqual(10);
  });

  it('every channelState entry round-trips digest + htlcsRoot', () => {
    for (const entry of oracle.channelState) {
      const state = reviveChannelState(entry.input);
      expect(htlcMerkleRoot(state.htlcs)).toBe(entry.htlcsRoot);
      expect(hashChannelState(state, oracle.domain.chainId, oracle.domain.verifyingContract)).toBe(
        entry.digest,
      );
    }
  });

  it('every htlc entry round-trips its digest', () => {
    for (const entry of oracle.htlc) {
      const h = reviveHtlc(entry.input);
      expect(hashHtlc(h, oracle.domain.chainId, oracle.domain.verifyingContract)).toBe(
        entry.digest,
      );
    }
  });

  it('every update entry round-trips its digest', () => {
    for (const entry of oracle.update) {
      const u = reviveUpdate(entry.input);
      expect(hashUpdate(u, oracle.domain.chainId, oracle.domain.verifyingContract)).toBe(
        entry.digest,
      );
    }
  });

  it('every cooperativeClose entry round-trips its digest', () => {
    for (const entry of oracle.cooperativeClose) {
      const c = reviveCooperativeClose(entry.input);
      expect(hashCooperativeClose(c, oracle.domain.chainId, oracle.domain.verifyingContract)).toBe(
        entry.digest,
      );
    }
  });

  it('digests across the four primaryTypes are distinct', () => {
    const all = new Set<string>();
    for (const e of oracle.channelState) all.add(e.digest);
    for (const e of oracle.htlc) all.add(e.digest);
    for (const e of oracle.update) all.add(e.digest);
    for (const e of oracle.cooperativeClose) all.add(e.digest);
    const total =
      oracle.channelState.length +
      oracle.htlc.length +
      oracle.update.length +
      oracle.cooperativeClose.length;
    expect(all.size).toBe(total);
  });

  it('non-empty htlc sets produce non-zero htlcsRoot', () => {
    const populated = oracle.channelState.filter((e) => e.input.htlcs.length > 0);
    expect(populated.length).toBeGreaterThan(0);
    for (const e of populated) {
      expect(e.htlcsRoot).not.toBe(
        '0x0000000000000000000000000000000000000000000000000000000000000000',
      );
    }
  });
});
