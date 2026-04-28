import type { ChannelState, Hex, Htlc, Update } from '@tainnel/protocol';
import { htlcMerkleRoot } from '@tainnel/protocol';
import fc from 'fast-check';
import { sha256 } from 'viem';
import { describe, it } from 'vitest';
import { applyUpdate, computeBalance, validateUpdate } from './channel.js';
import { StaleVersionError } from './errors.js';
import { addHtlc, expireHtlcs, failHtlc, settleHtlc } from './htlc.js';

const channelId = '0x0000000000000000000000000000000000000000000000000000000000000077' as const;

function bytes32From(seed: number): Hex {
  return `0x${seed.toString(16).padStart(64, '0')}` as Hex;
}

function preimagePair(seed: number): { preimage: Hex; paymentHash: Hex } {
  const preimage = `0x${seed.toString(16).padStart(64, '0')}` as Hex;
  const paymentHash = sha256(preimage) as Hex;
  return { preimage, paymentHash };
}

const direction = fc.constantFrom<'AtoB' | 'BtoA'>('AtoB', 'BtoA');

const htlcArb = fc
  .record({
    seed: fc.integer({ min: 1, max: 0xffffffff }),
    amount: fc.bigInt({ min: 1n, max: 1_000_000n }),
    direction,
    expiryMs: fc.bigInt({ min: 1n, max: 10_000_000n }),
  })
  .map(
    ({ seed, amount, direction: dir, expiryMs }): Htlc => ({
      id: bytes32From(seed),
      amount,
      direction: dir,
      paymentHash: preimagePair(seed).paymentHash,
      expiryMs,
    }),
  );

function uniqueHtlcs(htlcs: readonly Htlc[]): Htlc[] {
  const seen = new Set<string>();
  const out: Htlc[] = [];
  for (const h of htlcs) {
    if (!seen.has(h.id)) {
      seen.add(h.id);
      out.push(h);
    }
  }
  return out;
}

function makeState(
  version: bigint,
  balanceA: bigint,
  balanceB: bigint,
  htlcs: readonly Htlc[] = [],
): ChannelState {
  return { channelId, version, balanceA, balanceB, htlcs, finalized: false };
}

describe('property: applyUpdate preserves total balance with pending htlcs', () => {
  it('preserves totalA + totalB across any monotonic version bump', () => {
    fc.assert(
      fc.property(
        fc.bigUintN(48),
        fc.bigUintN(48),
        fc.bigUintN(32),
        fc.bigUintN(32),
        fc.array(htlcArb, { maxLength: 4 }),
        (a, b, fromV, bump, rawHtlcs) => {
          const htlcs = uniqueHtlcs(rawHtlcs);
          const total = a + b;
          const prev = makeState(fromV, a, b, []);
          const next = makeState(fromV + bump + 1n, b, a, htlcs);
          const lockedA = htlcs
            .filter((h) => h.direction === 'AtoB')
            .reduce((s, h) => s + h.amount, 0n);
          const lockedB = htlcs
            .filter((h) => h.direction === 'BtoA')
            .reduce((s, h) => s + h.amount, 0n);
          if (lockedA > b || lockedB > a) return true;
          const adjusted: ChannelState = {
            ...next,
            balanceA: b - lockedA,
            balanceB: a - lockedB,
          };
          const update: Update = {
            channelId,
            fromVersion: fromV,
            toVersion: fromV + bump + 1n,
            nextState: adjusted,
          };
          const result = applyUpdate(prev, update);
          const totals = computeBalance(result);
          return totals.totalA + totals.totalB === total;
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('property: addHtlc → settleHtlc(preimage) round-trip', () => {
  it('moves the htlc amount to the receiver, total unchanged', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 0xffffffff }),
        fc.bigInt({ min: 1n, max: 1_000_000n }),
        fc.bigInt({ min: 1_000_000n, max: 10_000_000n }),
        fc.bigInt({ min: 1_000_000n, max: 10_000_000n }),
        direction,
        (seed, amount, balanceA, balanceB, dir) => {
          const { preimage, paymentHash } = preimagePair(seed);
          const htlc: Htlc = {
            id: bytes32From(seed ^ 0xa1b2c3d4),
            direction: dir,
            amount,
            paymentHash,
            expiryMs: 9_999_999n,
          };
          const start = makeState(1n, balanceA, balanceB, []);
          const totalBefore = balanceA + balanceB;
          const afterAdd = addHtlc(start, htlc);
          const settled = settleHtlc(afterAdd, htlc.id, preimage);
          if (dir === 'AtoB') {
            return (
              settled.balanceA === balanceA - amount &&
              settled.balanceB === balanceB + amount &&
              settled.htlcs.length === 0 &&
              settled.balanceA + settled.balanceB === totalBefore
            );
          }
          return (
            settled.balanceA === balanceA + amount &&
            settled.balanceB === balanceB - amount &&
            settled.htlcs.length === 0 &&
            settled.balanceA + settled.balanceB === totalBefore
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('property: addHtlc → failHtlc round-trip', () => {
  it('refunds the sender exactly', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 0xffffffff }),
        fc.bigInt({ min: 1n, max: 1_000_000n }),
        fc.bigInt({ min: 1_000_000n, max: 10_000_000n }),
        fc.bigInt({ min: 1_000_000n, max: 10_000_000n }),
        direction,
        (seed, amount, balanceA, balanceB, dir) => {
          const htlc: Htlc = {
            id: bytes32From(seed),
            direction: dir,
            amount,
            paymentHash: preimagePair(seed).paymentHash,
            expiryMs: 9_999_999n,
          };
          const start = makeState(1n, balanceA, balanceB, []);
          const failed = failHtlc(addHtlc(start, htlc), htlc.id);
          return (
            failed.balanceA === balanceA &&
            failed.balanceB === balanceB &&
            failed.htlcs.length === 0
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('property: expireHtlcs is idempotent', () => {
  it('expireHtlcs(expireHtlcs(s, t), t) === expireHtlcs(s, t)', () => {
    fc.assert(
      fc.property(
        fc.array(htlcArb, { maxLength: 6 }),
        fc.bigInt({ min: 0n, max: 20_000_000n }),
        fc.bigInt({ min: 1_000_000n, max: 10_000_000n }),
        fc.bigInt({ min: 1_000_000n, max: 10_000_000n }),
        (rawHtlcs, nowMs, balanceA, balanceB) => {
          const htlcs = uniqueHtlcs(rawHtlcs).filter((h) => {
            if (h.direction === 'AtoB') return h.amount <= balanceA;
            return h.amount <= balanceB;
          });
          let lockedA = 0n;
          let lockedB = 0n;
          const accepted: Htlc[] = [];
          let curA = balanceA;
          let curB = balanceB;
          for (const h of htlcs) {
            if (h.direction === 'AtoB') {
              if (h.amount > curA) continue;
              curA -= h.amount;
              lockedA += h.amount;
            } else {
              if (h.amount > curB) continue;
              curB -= h.amount;
              lockedB += h.amount;
            }
            accepted.push(h);
          }
          const start = makeState(1n, curA, curB, accepted);
          const once = expireHtlcs(start, nowMs);
          const twice = expireHtlcs(once, nowMs);
          if (once.balanceA !== twice.balanceA || once.balanceB !== twice.balanceB) return false;
          if (once.htlcs.length !== twice.htlcs.length) return false;
          for (let i = 0; i < once.htlcs.length; i++) {
            if (once.htlcs[i]?.id !== twice.htlcs[i]?.id) return false;
          }
          return lockedA + lockedB >= 0n;
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('property: replay attack rejection', () => {
  it('throws StaleVersionError for any toVersion ≤ prev.version', () => {
    fc.assert(
      fc.property(
        fc.bigUintN(48),
        fc.bigUintN(48),
        fc.bigUintN(48),
        (current, balanceA, balanceB) => {
          const prev = makeState(current + 1n, balanceA, balanceB, []);
          const update: Update = {
            channelId,
            fromVersion: current + 1n,
            toVersion: current + 1n,
            nextState: makeState(current + 1n, balanceA, balanceB, []),
          };
          try {
            validateUpdate(prev, update);
            return false;
          } catch (err) {
            return err instanceof StaleVersionError;
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('property: sorted-merkle determinism', () => {
  function shuffle<T>(arr: readonly T[], seed: number): T[] {
    const copy = [...arr];
    let s = seed;
    for (let i = copy.length - 1; i > 0; i--) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const j = s % (i + 1);
      const tmp = copy[i] as T;
      copy[i] = copy[j] as T;
      copy[j] = tmp;
    }
    return copy;
  }

  it('shuffling input does not change root', () => {
    fc.assert(
      fc.property(
        fc.array(htlcArb, { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 1, max: 0xffffffff }),
        (rawHtlcs, seed) => {
          const htlcs = uniqueHtlcs(rawHtlcs);
          const rootA = htlcMerkleRoot(htlcs);
          const rootB = htlcMerkleRoot(shuffle(htlcs, seed));
          return rootA === rootB;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('returns a 32-byte hex root for any non-empty input', () => {
    fc.assert(
      fc.property(fc.array(htlcArb, { minLength: 1, maxLength: 8 }), (rawHtlcs) => {
        const htlcs = uniqueHtlcs(rawHtlcs);
        const root = htlcMerkleRoot(htlcs);
        return /^0x[0-9a-f]{64}$/.test(root);
      }),
      { numRuns: 100 },
    );
  });
});
