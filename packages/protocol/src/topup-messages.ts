import type { ChannelId, ChannelState, Hex, SignedState } from './types.js';

/**
 * Top-up fee schedule. Mirrors the hub's `FlatPlusBpsFeePolicy` constructor
 * arguments: a flat per-top-up component plus an `amount * bps / 10_000`
 * proportional component. Both expressed in USDC base units / basis points.
 */
export interface TopUpFeePolicy {
  readonly flat: bigint;
  readonly bps: bigint;
}

/**
 * Hub→user offer envelope for `proposeTopUp`. See protocol-spec §8.6.
 *
 * The envelope is signed implicitly via `prevSig` (hub's sig on the latest
 * dual-signed state baseline) and `newSig` (hub's sig on the proposed
 * post-top-up state). The user, on accept, returns a `signedNewState` carrying
 * both sigs; the hub then submits the on-chain `topUp(...)` tx within
 * `validUntil`.
 */
export interface TopUpOfferEnvelope {
  readonly kind: 'proposeTopUp';
  readonly channelId: ChannelId;
  readonly offerId: Hex;
  readonly amount: bigint;
  readonly prevStateVersion: bigint;
  readonly newState: ChannelState;
  readonly validUntil: bigint;
  readonly feePolicy: TopUpFeePolicy | null;
  readonly minLifetime: bigint | null;
  readonly maxInFlightHtlcs: number;
  readonly partialAccepted: boolean;
  readonly prevSig: Hex;
  readonly newSig: Hex;
}

/**
 * Hub→user `proposeTopUp` request message: the offer envelope plus a
 * transport-level request id.
 */
export interface ProposeTopUpMessage extends TopUpOfferEnvelope {
  readonly id: string;
}

/**
 * User→hub response accepting a top-up offer. Carries the user's co-signature
 * on the proposed post-top-up `newState`.
 */
export interface AcceptTopUpMessage {
  readonly id: string;
  readonly kind: 'acceptTopUp';
  readonly channelId: ChannelId;
  readonly offerId: Hex;
  readonly signedNewState: SignedState;
}

/**
 * User→hub response rejecting a top-up offer. Purely informational — the user
 * has signed nothing; the hub withdraws the offer.
 */
export interface RejectTopUpMessage {
  readonly id: string;
  readonly kind: 'rejectTopUp';
  readonly channelId: ChannelId;
  readonly offerId: Hex;
  readonly reason: string;
}

/**
 * Hub→user notification once the on-chain `topUp(...)` tx confirms. Allows
 * the client to advance its local view without waiting for an independent
 * chain-watcher pass.
 */
export interface TopUpCompleteMessage {
  readonly id: string;
  readonly kind: 'topUpComplete';
  readonly channelId: ChannelId;
  readonly offerId: Hex;
  readonly newVersion: bigint;
  readonly txHash: Hex;
}
