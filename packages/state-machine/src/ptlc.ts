/**
 * Point Time-Locked Contracts (PTLC) helpers — item 5 of the privacy plan.
 *
 * v1 of the pico protocol uses hashlocks: `paymentHash = sha256(preimage)`,
 * with the **same hash** on both HTLC legs of a routed payment (§4.1).
 * That makes any future on-chain dispute (§5.4 v2 milestone) a passive
 * correlation oracle: an observer who sees the two reveals can prove
 * the two legs belong to one payment.
 *
 * A PTLC fixes that by using a secp256k1 *point* commitment `T = s·G`.
 * Each hop tweaks the point by a fresh scalar `t`, so the two legs of a
 * single routed payment carry different commitments (`T_inner` and
 * `T_outer = T_inner + t·G`) that no third party can link without
 * knowing `t`.
 *
 * The math here is generic over any group with point-addition and
 * scalar-addition — the abstract `PtlcGroup` lets us test the protocol
 * shape against a toy modular-arithmetic group while keeping production
 * code free to plug in `@noble/curves/secp256k1` later.
 *
 * STUB: production v2 PTLCs MUST use secp256k1. The `PtlcGroup` interface
 * is shaped exactly so that swap is the only change needed.
 */
export interface PtlcGroup<P, S> {
  /** scalar · G (the commitment / point lock). */
  commit(scalar: S): P;
  /** Group operation on points. */
  pointAdd(a: P, b: P): P;
  /** Group operation on scalars (modular addition in the curve order). */
  scalarAdd(a: S, b: S): S;
  /** Constant-time equality on points; tests may use the natural one. */
  pointEq(a: P, b: P): boolean;
}

/**
 * `true` iff `commit(scalar) == point`. The settler reveals `scalar`; the
 * channel state-machine calls this in place of `verifyPreimage` once v2
 * lands.
 */
export function ptlcVerify<P, S>(
  group: PtlcGroup<P, S>,
  point: P,
  scalar: S,
): boolean {
  return group.pointEq(point, group.commit(scalar));
}

/**
 * Given the inner-leg point `innerPoint` and a per-hop tweak `tweak`,
 * compute the outer-leg point that the sender's HTLC should commit to:
 *   outerPoint = innerPoint + tweak·G
 *
 * The recipient picks `innerPoint = r·G` and hands the hub `tweak`. The
 * sender sees only `outerPoint`. The hub sees only `(innerPoint,
 * tweak)`. No third party who sees only `outerPoint` can recover
 * `innerPoint` without `tweak`.
 */
export function ptlcOuterPoint<P, S>(
  group: PtlcGroup<P, S>,
  innerPoint: P,
  tweak: S,
): P {
  return group.pointAdd(innerPoint, group.commit(tweak));
}

/**
 * Given the inner-leg scalar `innerScalar` revealed when the recipient
 * settles, plus the hub's `tweak`, derive the outer-leg scalar:
 *   outerScalar = innerScalar + tweak
 * `ptlcVerify(group, ptlcOuterPoint(group, innerPoint, tweak), outerScalar) === true`.
 */
export function ptlcOuterScalar<P, S>(
  group: PtlcGroup<P, S>,
  innerScalar: S,
  tweak: S,
): S {
  return group.scalarAdd(innerScalar, tweak);
}
