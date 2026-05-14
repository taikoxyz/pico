import {
  type ChannelState,
  HTLC_TIMEOUT_DELTA_MS,
  type Htlc,
  MAX_HTLCS_PER_CHANNEL,
  MAX_HTLC_DURATION_MS,
  MAX_HTLC_VALUE_PER_COUNTERPARTY,
  MIN_HTLC_DURATION_MS,
  type Preimage,
} from '@inferenceroom/pico-protocol';
import { StateMachineError, UnknownHtlcError } from './errors.js';
import { verifyPreimage } from './preimage.js';

function withHtlcsDerived(
  state: ChannelState,
  htlcs: readonly Htlc[],
  balances: { balanceA: bigint; balanceB: bigint },
): ChannelState {
  let total = 0n;
  for (const h of htlcs) total += h.amount;
  return {
    ...state,
    balanceA: balances.balanceA,
    balanceB: balances.balanceB,
    htlcs,
    htlcsCount: htlcs.length,
    htlcsTotalLocked: total,
  };
}

export function addHtlc(state: ChannelState, htlc: Htlc): ChannelState {
  if (htlc.amount <= 0n) {
    throw new StateMachineError('htlc amount must be positive', 'ZERO_AMOUNT');
  }
  if (state.htlcs.some((existing) => existing.id === htlc.id)) {
    throw new StateMachineError('duplicate htlc id', 'DUPLICATE_HTLC');
  }
  const htlcs = [...state.htlcs, htlc];
  if (htlc.direction === 'AtoB') {
    if (state.balanceA < htlc.amount) {
      throw new StateMachineError('insufficient balance to add htlc', 'INSUFFICIENT_BALANCE');
    }
    return withHtlcsDerived(state, htlcs, {
      balanceA: state.balanceA - htlc.amount,
      balanceB: state.balanceB,
    });
  }
  if (state.balanceB < htlc.amount) {
    throw new StateMachineError('insufficient balance to add htlc', 'INSUFFICIENT_BALANCE');
  }
  return withHtlcsDerived(state, htlcs, {
    balanceA: state.balanceA,
    balanceB: state.balanceB - htlc.amount,
  });
}

export function settleHtlc(state: ChannelState, id: string, preimage: Preimage): ChannelState {
  const htlc = state.htlcs.find((h) => h.id === id);
  if (!htlc) throw new UnknownHtlcError(id);
  if (!verifyPreimage(htlc.paymentHash, preimage)) {
    throw new StateMachineError('preimage does not match payment hash', 'BAD_PREIMAGE');
  }
  const remaining = state.htlcs.filter((h) => h.id !== id);
  if (htlc.direction === 'AtoB') {
    return withHtlcsDerived(state, remaining, {
      balanceA: state.balanceA,
      balanceB: state.balanceB + htlc.amount,
    });
  }
  return withHtlcsDerived(state, remaining, {
    balanceA: state.balanceA + htlc.amount,
    balanceB: state.balanceB,
  });
}

export function failHtlc(state: ChannelState, id: string): ChannelState {
  const htlc = state.htlcs.find((h) => h.id === id);
  if (!htlc) throw new UnknownHtlcError(id);
  const remaining = state.htlcs.filter((h) => h.id !== id);
  if (htlc.direction === 'AtoB') {
    return withHtlcsDerived(state, remaining, {
      balanceA: state.balanceA + htlc.amount,
      balanceB: state.balanceB,
    });
  }
  return withHtlcsDerived(state, remaining, {
    balanceA: state.balanceA,
    balanceB: state.balanceB + htlc.amount,
  });
}

export function expireHtlcs(state: ChannelState, nowMs: bigint): ChannelState {
  let next = state;
  for (const htlc of state.htlcs) {
    if (htlc.expiryMs <= nowMs) {
      next = failHtlc(next, htlc.id);
    }
  }
  return next;
}

export interface HtlcAdmissionContext {
  /** Number of in-flight HTLCs already on this channel (after pending admit). */
  readonly currentHtlcCount: number;
  /** Aggregate in-flight HTLC value across this channel. */
  readonly perChannelInflightValue: bigint;
  /** Aggregate in-flight HTLC value across all channels with this counterparty. */
  readonly perCounterpartyInflightValue: bigint;
  /** Smaller of the channel's two amounts (`min(amountA, amountB)`). */
  readonly maxPerChannelValue: bigint;
  /**
   * Per-counterparty value ceiling in the channel token's base units. Round-4
   * smoke (issue #100 follow-up) showed `MAX_HTLC_VALUE_PER_COUNTERPARTY`
   * (100 USDC at 6 decimals = 1e8 wei) being applied verbatim to native-ETH
   * (18 decimals) traffic, which then rejected even a 0.00001 ETH payment
   * (1e13 wei ≫ 1e8). Callers (the hub router) compute this per channel
   * token. If omitted, the legacy `MAX_HTLC_VALUE_PER_COUNTERPARTY` is used
   * for backwards-compatibility with existing tests.
   */
  readonly maxPerCounterpartyValue?: bigint;
  /** Current time in milliseconds (for expiry duration check). */
  readonly nowMs: bigint;
}

export interface HtlcAdmissionResult {
  readonly ok: boolean;
  readonly reason?: string;
}

export function checkHtlcAdmissible(htlc: Htlc, ctx: HtlcAdmissionContext): HtlcAdmissionResult {
  // 1. count cap (§4.3)
  if (ctx.currentHtlcCount >= MAX_HTLCS_PER_CHANNEL) {
    return { ok: false, reason: `htlc count would exceed ${MAX_HTLCS_PER_CHANNEL}` };
  }
  // 2. per-channel value cap
  if (ctx.perChannelInflightValue + htlc.amount > ctx.maxPerChannelValue) {
    return { ok: false, reason: 'per-channel inflight value would exceed min(amountA, amountB)' };
  }
  // 3. per-counterparty aggregate cap (per channel token's base units).
  const maxPerCounterparty = ctx.maxPerCounterpartyValue ?? MAX_HTLC_VALUE_PER_COUNTERPARTY;
  if (ctx.perCounterpartyInflightValue + htlc.amount > maxPerCounterparty) {
    return {
      ok: false,
      reason: `per-counterparty inflight would exceed ${maxPerCounterparty}`,
    };
  }
  // 4. duration bounds
  const dt = htlc.expiryMs - ctx.nowMs;
  if (dt < BigInt(MIN_HTLC_DURATION_MS)) {
    return { ok: false, reason: `htlc expiry-now < ${MIN_HTLC_DURATION_MS}ms` };
  }
  if (dt > BigInt(MAX_HTLC_DURATION_MS)) {
    return { ok: false, reason: `htlc expiry-now > ${MAX_HTLC_DURATION_MS}ms` };
  }
  return { ok: true };
}

/**
 * Hub-side check: outer (sender) and inner (hub) HTLC expiries must be
 * separated by at least HTLC_TIMEOUT_DELTA_MS so the hub can claim from
 * the sender after settling with the receiver. See §4.3.
 */
export function checkTimeoutDelta(
  outerExpiryMs: bigint,
  innerExpiryMs: bigint,
): HtlcAdmissionResult {
  if (outerExpiryMs - innerExpiryMs < BigInt(HTLC_TIMEOUT_DELTA_MS)) {
    return {
      ok: false,
      reason: `outer-inner expiry delta < ${HTLC_TIMEOUT_DELTA_MS}ms`,
    };
  }
  return { ok: true };
}
