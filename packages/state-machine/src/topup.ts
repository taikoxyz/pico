import type { ChannelState, SignedState } from '@inferenceroom/pico-protocol';
import { StateMachineError } from './errors.js';

const ZERO32 = '0x0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Detects the opener-only `version: 1` placeholder constructed by
 * `client.open()`: same balances as the on-chain implicit-initial state, no
 * HTLCs, not finalized, but only one side has signed (the opener). Per spec
 * §8 + scenarios doc Scenario 5 ("topUp overwrites the local version: 1 with
 * a fully co-signed one"), both the SDK acceptance path and the hub proposal
 * path must treat such a state as equivalent to the version=0 sentinel.
 */
export function isOpenerOnlyPlaceholder(s: SignedState): boolean {
  if (s.state.version !== 1n) return false;
  if (s.state.htlcs.length !== 0) return false;
  if (s.state.finalized) return false;
  const aZero = s.sigA.r === ZERO32 && s.sigA.s === ZERO32;
  const bZero = s.sigB.r === ZERO32 && s.sigB.s === ZERO32;
  return aZero !== bZero;
}

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
