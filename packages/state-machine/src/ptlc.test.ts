import { describe, expect, it } from 'vitest';
import {
  type PtlcGroup,
  ptlcOuterPoint,
  ptlcOuterScalar,
  ptlcVerify,
} from './ptlc.js';

// ---- Toy group for testing the PTLC algebra ----
//
// `Z_p` under multiplication, generator `G`. Points are bigints mod P,
// scalars are bigints mod (P-1). This is the discrete-log mapping:
// scalar `s` maps to point `G^s mod P`. The point/scalar operations
// have exactly the structure PTLCs require (point-add = mul mod P,
// scalar-add = add mod order). A real impl swaps this for secp256k1.
//
// The prime here is small for test-clarity, not security.
const PRIME = 2_147_483_647n; // 2^31 - 1, a Mersenne prime
const ORDER = PRIME - 1n;
const GENERATOR = 7n;

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = ((base % mod) + mod) % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    e >>= 1n;
    b = (b * b) % mod;
  }
  return result;
}

function modAdd(a: bigint, b: bigint, mod: bigint): bigint {
  return ((a + b) % mod + mod) % mod;
}

const toyGroup: PtlcGroup<bigint, bigint> = {
  commit: (s) => modPow(GENERATOR, s, PRIME),
  pointAdd: (a, b) => (a * b) % PRIME,
  scalarAdd: (a, b) => modAdd(a, b, ORDER),
  pointEq: (a, b) => a === b,
};

describe('ptlcVerify (item 5)', () => {
  it('accepts the scalar that opens the commitment', () => {
    const scalar = 12345n;
    const point = toyGroup.commit(scalar);
    expect(ptlcVerify(toyGroup, point, scalar)).toBe(true);
  });

  it('rejects a different scalar', () => {
    const scalar = 12345n;
    const point = toyGroup.commit(scalar);
    expect(ptlcVerify(toyGroup, point, scalar + 1n)).toBe(false);
  });

  it('different scalars produce different points', () => {
    const p1 = toyGroup.commit(1n);
    const p2 = toyGroup.commit(2n);
    expect(p1).not.toBe(p2);
  });
});

describe('PTLC tweak composition (cross-leg unlinkability)', () => {
  // recipient picks r, gives the hub innerPoint = r·G and tweak t.
  // sender's HTLC carries outerPoint = innerPoint + t·G = (r+t)·G.
  // When the recipient reveals r (by settling the inner-leg HTLC), the
  // hub computes (r+t) to settle the outer-leg HTLC.

  it('outer point opens with (innerScalar + tweak)', () => {
    const innerScalar = 99n;
    const tweak = 4242n;
    const innerPoint = toyGroup.commit(innerScalar);

    const outerPoint = ptlcOuterPoint(toyGroup, innerPoint, tweak);
    const outerScalar = ptlcOuterScalar(toyGroup, innerScalar, tweak);

    expect(ptlcVerify(toyGroup, outerPoint, outerScalar)).toBe(true);
  });

  it('outer point does NOT equal inner point (legs are distinct on chain)', () => {
    const innerScalar = 7n;
    const tweak = 11n;
    const innerPoint = toyGroup.commit(innerScalar);
    const outerPoint = ptlcOuterPoint(toyGroup, innerPoint, tweak);
    expect(outerPoint).not.toBe(innerPoint);
  });

  it('inner scalar alone does not open the outer point', () => {
    // Models: an observer who learns the inner reveal but does not know
    // the hub's tweak cannot settle the outer leg.
    const innerScalar = 7n;
    const tweak = 11n;
    const innerPoint = toyGroup.commit(innerScalar);
    const outerPoint = ptlcOuterPoint(toyGroup, innerPoint, tweak);
    expect(ptlcVerify(toyGroup, outerPoint, innerScalar)).toBe(false);
  });

  it('different tweaks yield different outer points for the same inner', () => {
    // Privacy property: re-using `innerPoint` with two different hubs
    // produces uncorrelated outer commitments.
    const innerScalar = 5n;
    const innerPoint = toyGroup.commit(innerScalar);
    const outerA = ptlcOuterPoint(toyGroup, innerPoint, 100n);
    const outerB = ptlcOuterPoint(toyGroup, innerPoint, 200n);
    expect(outerA).not.toBe(outerB);
  });

  it('associative: tweaking twice == tweaking once with the sum', () => {
    const innerScalar = 5n;
    const innerPoint = toyGroup.commit(innerScalar);
    const t1 = 100n;
    const t2 = 50n;
    const sequential = ptlcOuterPoint(toyGroup, ptlcOuterPoint(toyGroup, innerPoint, t1), t2);
    const combined = ptlcOuterPoint(toyGroup, innerPoint, toyGroup.scalarAdd(t1, t2));
    expect(sequential).toBe(combined);
  });

  it('zero tweak is a no-op (sanity)', () => {
    const innerScalar = 5n;
    const innerPoint = toyGroup.commit(innerScalar);
    const outer = ptlcOuterPoint(toyGroup, innerPoint, 0n);
    expect(outer).toBe(innerPoint);
    expect(ptlcOuterScalar(toyGroup, innerScalar, 0n)).toBe(innerScalar);
  });
});

describe('PTLC end-to-end routed-payment shape', () => {
  it('hub learns inner-leg scalar -> derives outer-leg scalar', () => {
    // 1. Recipient picks secret r.
    const r = 0xdeadn;
    const innerPoint = toyGroup.commit(r);

    // 2. Hub picks tweak t and announces outerPoint to the sender.
    const t = 0xbeefn;
    const outerPoint = ptlcOuterPoint(toyGroup, innerPoint, t);

    // 3. Sender locks an HTLC with `outerPoint` (the outer leg).
    // 4. Hub locks an HTLC with `innerPoint` (the inner leg).
    // 5. Recipient settles inner leg by revealing r.
    const innerReveal = r;
    expect(ptlcVerify(toyGroup, innerPoint, innerReveal)).toBe(true);

    // 6. Hub computes outer reveal and settles outer leg.
    const outerReveal = ptlcOuterScalar(toyGroup, innerReveal, t);
    expect(ptlcVerify(toyGroup, outerPoint, outerReveal)).toBe(true);

    // Cross-check: someone who sees only outerPoint and outerReveal cannot
    // recover innerPoint without knowing t (we only assert the trivial
    // algebraic non-equality here; cryptographic hardness is a property
    // of the real secp256k1 impl, not the toy group).
    expect(outerPoint).not.toBe(innerPoint);
    expect(outerReveal).not.toBe(innerReveal);
  });
});
