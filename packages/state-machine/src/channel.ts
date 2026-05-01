import type { ChannelState, Update } from '@tainnel/protocol';
import { BalanceMismatchError, StateMachineError } from './errors.js';
import { ensureMonotonicVersion } from './replay.js';

export function computeBalance(state: ChannelState): { totalA: bigint; totalB: bigint } {
  let totalA = state.balanceA;
  let totalB = state.balanceB;
  for (const htlc of state.htlcs) {
    if (htlc.direction === 'AtoB') {
      totalA += htlc.amount;
    } else {
      totalB += htlc.amount;
    }
  }
  return { totalA, totalB };
}

export function validateUpdate(prev: ChannelState, update: Update): void {
  if (update.channelId !== prev.channelId) {
    throw new StateMachineError('channel id mismatch', 'CHANNEL_ID_MISMATCH');
  }
  if (update.nextState.channelId !== update.channelId) {
    throw new StateMachineError(
      'nested nextState.channelId does not match wrapper channelId',
      'CHANNEL_ID_MISMATCH',
    );
  }
  if (update.fromVersion !== prev.version) {
    throw new StateMachineError('fromVersion does not match prev', 'FROM_VERSION_MISMATCH');
  }
  if (prev.finalized) {
    throw new StateMachineError('channel already finalized', 'FINALIZED');
  }
  ensureMonotonicVersion(prev.version, update.toVersion);
  if (update.nextState.version !== update.toVersion) {
    throw new StateMachineError('nextState.version must equal toVersion', 'VERSION_MISMATCH');
  }
  if (update.nextState.finalized && update.nextState.htlcs.length > 0) {
    throw new StateMachineError('cannot finalize with pending htlcs', 'PENDING_HTLCS');
  }
  const before = computeBalance(prev);
  const after = computeBalance(update.nextState);
  if (before.totalA + before.totalB !== after.totalA + after.totalB) {
    throw new BalanceMismatchError();
  }
}

export function applyUpdate(prev: ChannelState, update: Update): ChannelState {
  validateUpdate(prev, update);
  return update.nextState;
}
