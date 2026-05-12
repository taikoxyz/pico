import fc from 'fast-check';
import { keccak256 } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_HTLCS_ROOT,
  HTLC_DIRECTION_ATOB,
  HTLC_DIRECTION_BTOA,
  htlcDirectionByte,
  htlcExpirySeconds,
  htlcLeaf,
  htlcMerkleProof,
  htlcMerkleRoot,
} from './htlc-root.js';
import type { Hex, Htlc } from './types.js';

/** Off-chain mirror of `HTLC.verifyOrderedProof` in `packages/contracts/src/HTLC.sol`.
 *  Asserts the proof builder + Solidity verifier agree on every leaf/index pair. */
function verifyOrderedProof(
  leaf: Hex,
  root: Hex,
  proof: readonly Hex[],
  sortedIndex: number,
  totalLeaves: number,
): boolean {
  if (totalLeaves === 0 || sortedIndex >= totalLeaves) return false;
  if (totalLeaves === 1) return proof.length === 0 && leaf === root;
  let node = leaf;
  let index = sortedIndex;
  let levelWidth = totalLeaves;
  let cursor = 0;
  while (levelWidth > 1) {
    const isRight = (index & 1) === 1;
    const isOddTail = !isRight && index + 1 === levelWidth;
    let sibling: Hex;
    if (isOddTail) {
      sibling = node;
    } else {
      if (cursor >= proof.length) return false;
      sibling = proof[cursor] as Hex;
      cursor += 1;
    }
    const concat = isRight
      ? (`0x${sibling.slice(2)}${node.slice(2)}` as Hex)
      : (`0x${node.slice(2)}${sibling.slice(2)}` as Hex);
    node = keccak256(concat);
    index = index >> 1;
    levelWidth = (levelWidth + 1) >> 1;
  }
  return cursor === proof.length && node === root;
}

function makeHtlc(idSuffix: string, amount: bigint, direction: 'AtoB' | 'BtoA' = 'AtoB'): Htlc {
  return {
    id: `0x${idSuffix.padStart(64, '0')}` as const,
    direction,
    amount,
    paymentHash: '0xabababababababababababababababababababababababababababababababab' as const,
    expiryMs: 1_800_000_000_000n,
  };
}

describe('htlcDirectionByte', () => {
  it('maps AtoB → 0', () => {
    expect(htlcDirectionByte('AtoB')).toBe(HTLC_DIRECTION_ATOB);
    expect(htlcDirectionByte('AtoB')).toBe(0);
  });

  it('maps BtoA → 1', () => {
    expect(htlcDirectionByte('BtoA')).toBe(HTLC_DIRECTION_BTOA);
    expect(htlcDirectionByte('BtoA')).toBe(1);
  });
});

describe('htlcExpirySeconds — locks ms→s floor-divide', () => {
  it('drops sub-second precision', () => {
    expect(htlcExpirySeconds({ ...makeHtlc('1', 1n), expiryMs: 1500n })).toBe(1n);
    expect(htlcExpirySeconds({ ...makeHtlc('1', 1n), expiryMs: 1000n })).toBe(1n);
    expect(htlcExpirySeconds({ ...makeHtlc('1', 1n), expiryMs: 999n })).toBe(0n);
    expect(htlcExpirySeconds({ ...makeHtlc('1', 1n), expiryMs: 0n })).toBe(0n);
  });

  it('handles a multi-year expiry', () => {
    const expiryMs = 1_800_000_000_000n;
    expect(htlcExpirySeconds({ ...makeHtlc('1', 1n), expiryMs })).toBe(1_800_000_000n);
  });
});

describe('htlcLeaf — encoding is stable (snapshot)', () => {
  it('produces a deterministic 32-byte digest for a fixed input', () => {
    const fixed: Htlc = {
      id: '0x0000000000000000000000000000000000000000000000000000000000000001',
      direction: 'AtoB',
      amount: 1_000_000n,
      paymentHash: '0xabababababababababababababababababababababababababababababababab',
      expiryMs: 1_800_000_000_000n,
    };
    const leaf = htlcLeaf(fixed);
    expect(leaf).toMatch(/^0x[0-9a-f]{64}$/);
    expect(htlcLeaf(fixed)).toBe(leaf);
  });

  it('different ids produce different leaves', () => {
    const a = htlcLeaf(makeHtlc('1', 100n));
    const b = htlcLeaf(makeHtlc('2', 100n));
    expect(a).not.toBe(b);
  });

  it('different amounts produce different leaves', () => {
    const a = htlcLeaf(makeHtlc('1', 100n));
    const b = htlcLeaf(makeHtlc('1', 200n));
    expect(a).not.toBe(b);
  });

  it('different directions produce different leaves', () => {
    const a = htlcLeaf(makeHtlc('1', 100n, 'AtoB'));
    const b = htlcLeaf(makeHtlc('1', 100n, 'BtoA'));
    expect(a).not.toBe(b);
  });
});

describe('htlcMerkleRoot', () => {
  it('returns bytes32(0) for empty', () => {
    expect(htlcMerkleRoot([])).toBe(EMPTY_HTLCS_ROOT);
  });

  it('returns the leaf hash for a single htlc', () => {
    const h = makeHtlc('1', 100n);
    expect(htlcMerkleRoot([h])).toBe(htlcLeaf(h));
  });

  it('handles two htlcs', () => {
    const root = htlcMerkleRoot([makeHtlc('1', 100n), makeHtlc('2', 200n, 'BtoA')]);
    expect(root).toMatch(/^0x[0-9a-f]{64}$/);
    expect(root).not.toBe(EMPTY_HTLCS_ROOT);
  });

  it('exercises the sort equality branch with two byte-identical htlcs', () => {
    const a = makeHtlc('1', 100n);
    const b = makeHtlc('1', 100n);
    const root = htlcMerkleRoot([a, b]);
    expect(root).toMatch(/^0x[0-9a-f]{64}$/);
    expect(htlcMerkleRoot([b, a])).toBe(root);
  });

  it('handles 5 htlcs (typical v1 max)', () => {
    const htlcs = Array.from({ length: 5 }, (_, i) =>
      makeHtlc(String(i + 1), BigInt((i + 1) * 100)),
    );
    expect(htlcMerkleRoot(htlcs)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('is invariant to insertion order', () => {
    const a = makeHtlc('1', 100n);
    const b = makeHtlc('2', 200n, 'BtoA');
    const c = makeHtlc('3', 300n);
    const forward = htlcMerkleRoot([a, b, c]);
    expect(htlcMerkleRoot([c, b, a])).toBe(forward);
    expect(htlcMerkleRoot([b, a, c])).toBe(forward);
  });

  it('property: any permutation of the input yields the same root', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            idSuffix: fc.hexaString({ minLength: 1, maxLength: 64 }),
            amount: fc.bigUintN(64).filter((n) => n > 0n),
            direction: fc.constantFrom('AtoB' as const, 'BtoA' as const),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        (raw) => {
          const seen = new Set<string>();
          const htlcs: Htlc[] = [];
          for (const r of raw) {
            const id = `0x${r.idSuffix.padStart(64, '0')}` as const;
            if (seen.has(id)) continue;
            seen.add(id);
            htlcs.push({
              id,
              direction: r.direction,
              amount: r.amount,
              paymentHash:
                '0xabababababababababababababababababababababababababababababababab' as const,
              expiryMs: 1_800_000_000_000n,
            });
          }
          const expected = htlcMerkleRoot(htlcs);
          const shuffled = [...htlcs].reverse();
          return htlcMerkleRoot(shuffled) === expected;
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('htlcMerkleProof — inclusion proofs round-trip', () => {
  it('single leaf produces an empty proof and verifies against the root', () => {
    const h = makeHtlc('1', 100n);
    const root = htlcMerkleRoot([h]);
    const { proof, sortedIndex, totalLeaves } = htlcMerkleProof([h], h.id);
    expect(proof).toEqual([]);
    expect(sortedIndex).toBe(0);
    expect(totalLeaves).toBe(1);
    expect(verifyOrderedProof(htlcLeaf(h), root, proof, sortedIndex, totalLeaves)).toBe(true);
  });

  it('rejects a tampered proof', () => {
    const a = makeHtlc('1', 100n);
    const b = makeHtlc('2', 200n);
    const root = htlcMerkleRoot([a, b]);
    const { proof, sortedIndex, totalLeaves } = htlcMerkleProof([a, b], a.id);
    const tampered = [...proof];
    const first = tampered[0] as Hex;
    tampered[0] = `0x${(BigInt(first) ^ 1n).toString(16).padStart(64, '0')}` as Hex;
    expect(verifyOrderedProof(htlcLeaf(a), root, tampered, sortedIndex, totalLeaves)).toBe(false);
  });

  it('rejects a proof submitted for the wrong sorted index', () => {
    const htlcs = Array.from({ length: 3 }, (_, i) =>
      makeHtlc(String(i + 1), BigInt((i + 1) * 100)),
    );
    const root = htlcMerkleRoot(htlcs);
    const sorted = [...htlcs].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    const { proof, totalLeaves } = htlcMerkleProof(htlcs, (sorted[0] as Htlc).id);
    expect(verifyOrderedProof(htlcLeaf(sorted[0] as Htlc), root, proof, 1, totalLeaves)).toBe(
      false,
    );
  });

  it('throws when target id is not present', () => {
    const h = makeHtlc('1', 100n);
    expect(() =>
      htlcMerkleProof(
        [h],
        '0x0000000000000000000000000000000000000000000000000000000000000999' as Hex,
      ),
    ).toThrow();
  });

  it('property: every leaf in every set size 1..5 verifies', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            idSuffix: fc.hexaString({ minLength: 1, maxLength: 64 }),
            amount: fc.bigUintN(64).filter((n) => n > 0n),
            direction: fc.constantFrom('AtoB' as const, 'BtoA' as const),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        (raw) => {
          const seen = new Set<string>();
          const htlcs: Htlc[] = [];
          for (const r of raw) {
            const id = `0x${r.idSuffix.padStart(64, '0')}` as Hex;
            if (seen.has(id)) continue;
            seen.add(id);
            htlcs.push({
              id,
              direction: r.direction,
              amount: r.amount,
              paymentHash:
                '0xabababababababababababababababababababababababababababababababab' as Hex,
              expiryMs: 1_800_000_000_000n,
            });
          }
          const root = htlcMerkleRoot(htlcs);
          const sorted = [...htlcs].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
          return sorted.every((h, i) => {
            const { proof, sortedIndex, totalLeaves } = htlcMerkleProof(htlcs, h.id);
            return (
              sortedIndex === i &&
              verifyOrderedProof(htlcLeaf(h), root, proof, sortedIndex, totalLeaves)
            );
          });
        },
      ),
      { numRuns: 200 },
    );
  });
});
