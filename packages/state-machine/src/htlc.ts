import {
  type ChannelState,
  type Hex,
  type Htlc,
  type PaymentHash,
  type Preimage,
  htlcLeaf,
  htlcMerkleRoot,
} from '@tainnel/protocol';
import { sha256 } from 'viem';
import { InvalidPreimageError, StateMachineError, UnknownHtlcError } from './errors.js';

export const computeHtlcsRoot = htlcMerkleRoot;
export const computeHtlcLeaf = htlcLeaf;

export function verifyPreimage(paymentHash: PaymentHash, preimage: Preimage): boolean {
  return (sha256(preimage) as Hex).toLowerCase() === paymentHash.toLowerCase();
}

export function addHtlc(state: ChannelState, htlc: Htlc): ChannelState {
  if (htlc.amount === 0n) {
    throw new StateMachineError('zero-amount htlc', 'ZERO_AMOUNT_HTLC');
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
    throw new InvalidPreimageError(id);
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
