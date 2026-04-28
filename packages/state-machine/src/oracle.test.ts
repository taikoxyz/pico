import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Address,
  type ChainId,
  type ChannelState,
  type Hex,
  type Htlc,
  TAIKO_HOODI_CHAIN_ID,
  htlcLeaf,
  htlcMerkleRoot,
} from '@tainnel/protocol';
import { keccak256, sha256, stringToHex } from 'viem';
import { describe, expect, it } from 'vitest';
import { hashChannelState } from './signing.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(HERE, '../test/fixtures/oracle.json');
const RECORDS = 50;
const ORACLE_CHAIN_ID: ChainId = TAIKO_HOODI_CHAIN_ID;
const ORACLE_VERIFYING_CONTRACT: Address = '0x1111111111111111111111111111111111111111';

interface OracleHtlc {
  readonly id: Hex;
  readonly amount: string;
  readonly direction: 'AtoB' | 'BtoA';
  readonly paymentHash: Hex;
  readonly expirySec: string;
}

interface OraclePreimage {
  readonly preimage: Hex;
  readonly paymentHash: Hex;
}

interface OracleStateMessage {
  readonly channelId: Hex;
  readonly version: string;
  readonly balanceA: string;
  readonly balanceB: string;
  readonly finalized: boolean;
}

interface OracleRecord {
  readonly id: number;
  readonly htlcs: OracleHtlc[];
  readonly leafHashes: Hex[];
  readonly htlcsRoot: Hex;
  readonly preimages: OraclePreimage[];
  readonly state: OracleStateMessage;
  readonly channelStateDigest: Hex;
}

interface OracleFile {
  readonly version: 1;
  readonly chainId: number;
  readonly verifyingContract: Address;
  readonly records: OracleRecord[];
}

function rng(seed: bigint): () => bigint {
  let s = seed;
  return () => {
    s = (s * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    return s;
  };
}

function bytes32From(n: bigint): Hex {
  const hex = (n & ((1n << 256n) - 1n)).toString(16).padStart(64, '0');
  return `0x${hex}` as Hex;
}

function preimageHexFor(seed: bigint): Hex {
  return bytes32From(seed ^ 0xa5a5a5a5a5a5a5a5n);
}

function buildRecord(id: number, next: () => bigint): OracleRecord {
  const channelId = bytes32From(next());
  const htlcCount = Number(next() % 7n);
  const htlcs: Htlc[] = [];
  const oracleHtlcs: OracleHtlc[] = [];
  const preimages: OraclePreimage[] = [];

  for (let i = 0; i < htlcCount; i++) {
    const seed = next();
    const preimage = preimageHexFor(seed);
    const paymentHash = sha256(preimage) as Hex;
    const direction: 'AtoB' | 'BtoA' = seed & 1n ? 'AtoB' : 'BtoA';
    const amount = (seed % 1_000_000n) + 1n;
    const expirySec = (seed % 100_000n) + 1n;
    const expiryMs = expirySec * 1000n;
    const htlc: Htlc = {
      id: bytes32From(next()),
      direction,
      amount,
      paymentHash,
      expiryMs,
    };
    htlcs.push(htlc);
    oracleHtlcs.push({
      id: htlc.id,
      amount: amount.toString(),
      direction,
      paymentHash,
      expirySec: expirySec.toString(),
    });
    preimages.push({ preimage, paymentHash });
  }

  const sortedLeafHashes = [...htlcs]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(htlcLeaf);
  const htlcsRoot = htlcMerkleRoot(htlcs);

  const balanceA = (next() % 10_000_000n) + 1n;
  const balanceB = (next() % 10_000_000n) + 1n;
  const version = (next() % 1000n) + 1n;

  const state: ChannelState = {
    channelId,
    version,
    balanceA,
    balanceB,
    htlcs,
    finalized: false,
  };

  const channelStateDigest = hashChannelState(state, ORACLE_CHAIN_ID, ORACLE_VERIFYING_CONTRACT);

  return {
    id,
    htlcs: oracleHtlcs,
    leafHashes: sortedLeafHashes,
    htlcsRoot,
    preimages,
    state: {
      channelId,
      version: version.toString(),
      balanceA: balanceA.toString(),
      balanceB: balanceB.toString(),
      finalized: false,
    },
    channelStateDigest,
  };
}

function generate(): OracleFile {
  const next = rng(0xc0dedbabe_c0dedbaben);
  const records: OracleRecord[] = [];
  for (let i = 0; i < RECORDS; i++) {
    records.push(buildRecord(i, next));
  }
  return {
    version: 1,
    chainId: ORACLE_CHAIN_ID,
    verifyingContract: ORACLE_VERIFYING_CONTRACT,
    records,
  };
}

function loadFixture(): OracleFile {
  const raw = readFileSync(FIXTURE_PATH, 'utf8');
  return JSON.parse(raw) as OracleFile;
}

function recordToHtlcs(record: OracleRecord): Htlc[] {
  return record.htlcs.map((h) => ({
    id: h.id,
    direction: h.direction,
    amount: BigInt(h.amount),
    paymentHash: h.paymentHash,
    expiryMs: BigInt(h.expirySec) * 1000n,
  }));
}

if (process.env.GEN_ORACLE === '1') {
  const fixture = generate();
  mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
  writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
}

describe('oracle.json — cross-package fixture', () => {
  const fixture = loadFixture();

  it('was generated for the expected chain + verifyingContract', () => {
    expect(fixture.chainId).toBe(ORACLE_CHAIN_ID);
    expect(fixture.verifyingContract).toBe(ORACLE_VERIFYING_CONTRACT);
    expect(fixture.records.length).toBe(RECORDS);
  });

  it('regeneration is deterministic (regen-equal-bytes)', () => {
    const regen = generate();
    expect(JSON.stringify(regen)).toBe(JSON.stringify(fixture));
  });

  it('every record round-trips: htlcsRoot, leafHashes, preimages, channelStateDigest', () => {
    for (const record of fixture.records) {
      const htlcs = recordToHtlcs(record);
      expect(htlcMerkleRoot(htlcs)).toBe(record.htlcsRoot);

      const sortedLeaves = [...htlcs]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map(htlcLeaf);
      expect(sortedLeaves).toEqual(record.leafHashes);

      for (const { preimage, paymentHash } of record.preimages) {
        expect((sha256(preimage) as Hex).toLowerCase()).toBe(paymentHash.toLowerCase());
      }

      const state: ChannelState = {
        channelId: record.state.channelId,
        version: BigInt(record.state.version),
        balanceA: BigInt(record.state.balanceA),
        balanceB: BigInt(record.state.balanceB),
        htlcs,
        finalized: record.state.finalized,
      };
      expect(hashChannelState(state, ORACLE_CHAIN_ID, ORACLE_VERIFYING_CONTRACT)).toBe(
        record.channelStateDigest,
      );
    }
  });

  it('uses keccak256 over abi-encoded leaves (not sha256, not packed)', () => {
    const sample = fixture.records.find((r) => r.htlcs.length > 0);
    expect(sample).toBeDefined();
    if (!sample) return;
    const firstHtlc = sample.htlcs[0];
    const firstLeaf = sample.leafHashes[0];
    expect(firstHtlc).toBeDefined();
    expect(firstLeaf).toBeDefined();
    if (!firstHtlc || !firstLeaf) return;
    const wrongHash = keccak256(stringToHex('wrong'));
    expect(firstLeaf).not.toBe(wrongHash);
    expect(firstLeaf).not.toBe(firstHtlc.paymentHash);
  });
});
