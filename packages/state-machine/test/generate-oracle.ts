import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Address,
  type ChannelState,
  type CooperativeClose,
  type Hex,
  type Htlc,
  TAIKO_HOODI_CHAIN_ID,
  type Update,
  htlcMerkleRoot,
} from '@tainnel/protocol';
import { hashChannelState, hashCooperativeClose, hashHtlc, hashUpdate } from '../src/signing.js';

const VERIFYING_CONTRACT = '0x1111111111111111111111111111111111111111' as Address;
const CHAIN_ID = TAIKO_HOODI_CHAIN_ID;

function hex32(n: number): Hex {
  return `0x${n.toString(16).padStart(64, '0')}` as Hex;
}

function paymentHash(seed: number): Hex {
  const byte = (seed % 256).toString(16).padStart(2, '0');
  return `0x${byte.repeat(32)}` as Hex;
}

function makeHtlc(seed: number, direction: 'AtoB' | 'BtoA' = 'AtoB'): Htlc {
  return {
    id: hex32(seed),
    direction,
    amount: BigInt(seed * 1000 + 1),
    paymentHash: paymentHash(seed),
    expiryMs: BigInt((seed + 1) * 1_000_000_000),
  };
}

function makeChannelState(version: number, htlcCount: number, finalized: boolean): ChannelState {
  const htlcs: Htlc[] = [];
  for (let i = 0; i < htlcCount; i++) {
    htlcs.push(makeHtlc(version * 100 + i + 1, i % 2 === 0 ? 'AtoB' : 'BtoA'));
  }
  return {
    channelId: hex32(version),
    version: BigInt(version),
    balanceA: BigInt(version * 10_000),
    balanceB: BigInt(version * 20_000),
    htlcs,
    finalized,
  };
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

interface ChannelStateFixture {
  input: ChannelState;
  digest: Hex;
  htlcsRoot: Hex;
}
interface HtlcFixture {
  input: Htlc;
  digest: Hex;
}
interface UpdateFixture {
  input: Update;
  digest: Hex;
}
interface CooperativeCloseFixture {
  input: CooperativeClose;
  digest: Hex;
}

interface Oracle {
  domain: { chainId: number; verifyingContract: Address };
  channelState: ChannelStateFixture[];
  htlc: HtlcFixture[];
  update: UpdateFixture[];
  cooperativeClose: CooperativeCloseFixture[];
}

function buildOracle(): Oracle {
  const channelState: ChannelStateFixture[] = [];
  for (let v = 1; v <= 12; v++) {
    const htlcCount = v % 6;
    const finalized = htlcCount === 0 && v % 4 === 0;
    const state = makeChannelState(v, htlcCount, finalized);
    channelState.push({
      input: state,
      digest: hashChannelState(state, CHAIN_ID, VERIFYING_CONTRACT),
      htlcsRoot: htlcMerkleRoot(state.htlcs),
    });
  }

  const htlc: HtlcFixture[] = [];
  for (let i = 1; i <= 12; i++) {
    const h = makeHtlc(i, i % 2 === 0 ? 'AtoB' : 'BtoA');
    htlc.push({ input: h, digest: hashHtlc(h, CHAIN_ID, VERIFYING_CONTRACT) });
  }

  const update: UpdateFixture[] = [];
  for (let v = 1; v <= 12; v++) {
    const prev = makeChannelState(v, 0, false);
    const next = makeChannelState(v + 1, v % 4, false);
    const nextWithSameChannelId: ChannelState = { ...next, channelId: prev.channelId };
    const u: Update = {
      channelId: prev.channelId,
      fromVersion: BigInt(v),
      toVersion: BigInt(v + 1),
      nextState: nextWithSameChannelId,
    };
    update.push({ input: u, digest: hashUpdate(u, CHAIN_ID, VERIFYING_CONTRACT) });
  }

  const cooperativeClose: CooperativeCloseFixture[] = [];
  for (let i = 1; i <= 12; i++) {
    const c: CooperativeClose = {
      channelId: hex32(i),
      finalBalanceA: BigInt(i * 1_000),
      finalBalanceB: BigInt(i * 2_000),
      signedAt: BigInt(1_700_000_000 + i * 60),
    };
    cooperativeClose.push({
      input: c,
      digest: hashCooperativeClose(c, CHAIN_ID, VERIFYING_CONTRACT),
    });
  }

  return {
    domain: { chainId: CHAIN_ID, verifyingContract: VERIFYING_CONTRACT },
    channelState,
    htlc,
    update,
    cooperativeClose,
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, 'fixtures', 'oracle.json');
const oracle = buildOracle();
writeFileSync(outPath, `${JSON.stringify(oracle, bigintReplacer, 2)}\n`);
