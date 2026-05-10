import type { ChannelState } from '@inferenceroom/pico-protocol';
import { StateMachineError } from './errors.js';

/**
 * Predict the post-top-up `ChannelState` given a co-signed `prevState`,
 * the depositor's side, the deposit amount, and the channel's current
 * on-chain amounts. Pure: no signatures, no I/O. Used by:
 * - The hub to construct the proposed `newState` in a `proposeTopUp`.
 * - The client to verify the hub's `newState` matches what the client
 *   expects given its local view of `prevState`.
 *
 * The on-chain amounts (`amountA`, `amountB`) reflect deposits to date,
 * NOT including this top-up. The returned state's balances assert the
 * post-top-up balance distribution; conservation against post-top-up
 * amounts (`amountA + amountB + amount`) is enforced by the contract.
 */
export function predictTopUpState(
  prev: ChannelState,
  side: 'A' | 'B',
  amount: bigint,
): ChannelState {
  if (amount <= 0n) {
    throw new StateMachineError('top-up amount must be positive', 'ZERO_AMOUNT');
  }
  if (prev.htlcs.length !== 0) {
    throw new StateMachineError('cannot top up while htlcs are in-flight', 'HTLCS_IN_FLIGHT');
  }
  if (prev.finalized) {
    throw new StateMachineError('cannot top up a finalized state', 'STATE_FINALIZED');
  }
  return {
    ...prev,
    version: prev.version + 1n,
    balanceA: side === 'A' ? prev.balanceA + amount : prev.balanceA,
    balanceB: side === 'B' ? prev.balanceB + amount : prev.balanceB,
  };
}
