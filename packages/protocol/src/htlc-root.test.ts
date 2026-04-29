import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_HTLCS_ROOT,
  HTLC_DIRECTION_ATOB,
  HTLC_DIRECTION_BTOA,
  htlcDirectionByte,
  htlcExpirySeconds,
  htlcLeaf,
  htlcMerkleRoot,
} from './htlc-root.js';
import type { Htlc } from './types.js';

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
