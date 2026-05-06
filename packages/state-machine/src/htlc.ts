import type { ChannelState, Htlc, Preimage } from '@inferenceroom/pico-protocol';
import { StateMachineError, UnknownHtlcError } from './errors.js';
import { verifyPreimage } from './preimage.js';

export function addHtlc(state: ChannelState, htlc: Htlc): ChannelState {
  if (htlc.amount <= 0n) {
    throw new StateMachineError('htlc amount must be positive', 'ZERO_AMOUNT');
  }
  if (state.htlcs.some((existing) => existing.id === htlc.id)) {
    throw new StateMachineError('duplicate htlc id', 'DUPLICATE_HTLC');
  }
  if (htlc.direction === 'AtoB') {
    if (state.balanceA < htlc.amount) {
      throw new StateMachineError('insufficient balance to add htlc', 'INSUFFICIENT_BALANCE');
    }
    return {
      ...state,
      balanceA: state.balanceA - htlc.amount,
      htlcs: [...state.htlcs, htlc],
    };
  }
  if (state.balanceB < htlc.amount) {
    throw new StateMachineError('insufficient balance to add htlc', 'INSUFFICIENT_BALANCE');
  }
  return {
    ...state,
    balanceB: state.balanceB - htlc.amount,
    htlcs: [...state.htlcs, htlc],
  };
}

export function settleHtlc(state: ChannelState, id: string, preimage: Preimage): ChannelState {
  const htlc = state.htlcs.find((h) => h.id === id);
  if (!htlc) throw new UnknownHtlcError(id);
  if (!verifyPreimage(htlc.paymentHash, preimage)) {
    throw new StateMachineError('preimage does not match payment hash', 'BAD_PREIMAGE');
  }
  const remaining = state.htlcs.filter((h) => h.id !== id);
  if (htlc.direction === 'AtoB') {
    return { ...state, balanceB: state.balanceB + htlc.amount, htlcs: remaining };
  }
  return { ...state, balanceA: state.balanceA + htlc.amount, htlcs: remaining };
}

export function failHtlc(state: ChannelState, id: string): ChannelState {
  const htlc = state.htlcs.find((h) => h.id === id);
  if (!htlc) throw new UnknownHtlcError(id);
  const remaining = state.htlcs.filter((h) => h.id !== id);
  if (htlc.direction === 'AtoB') {
    return { ...state, balanceA: state.balanceA + htlc.amount, htlcs: remaining };
  }
  return { ...state, balanceB: state.balanceB + htlc.amount, htlcs: remaining };
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
