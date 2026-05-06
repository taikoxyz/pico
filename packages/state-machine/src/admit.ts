import type {
  Address,
  ChainId,
  Channel,
  ChannelState,
  Htlc,
  HtlcId,
  PaymentHash,
  Preimage,
  SignedState,
} from '@inferenceroom/pico-protocol';
import { computeBalance } from './channel.js';
import { verifyPreimage } from './preimage.js';
import { verifyChannelStateSignature } from './signing.js';

export type AdmitFailureCode =
  | 'CHANNEL_ID_MISMATCH'
  | 'CHANNEL_STATUS_INVALID'
  | 'VERSION_NOT_MONOTONIC'
  | 'BALANCE_NOT_CONSERVED'
  | 'BAD_SIGNATURE_A'
  | 'BAD_SIGNATURE_B'
  | 'HTLC_NOT_FOUND'
  | 'HTLC_FIELDS_MISMATCH'
  | 'EXPECTED_HTLC_PRESENT'
  | 'EXPECTED_HTLC_ABSENT'
  | 'PREIMAGE_MISMATCH'
  | 'NOT_FINALIZED'
  | 'NON_EMPTY_HTLCS'
  | 'FINALIZED_BALANCE_MISMATCH';

export class StateAdmissionError extends Error {
  readonly code: AdmitFailureCode;
  constructor(code: AdmitFailureCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'StateAdmissionError';
  }
}

export interface AdmitContext {
  readonly channel: Channel;
  readonly chainId: ChainId;
  readonly verifyingContract: Address;
}

export interface AdmitSignedStateOpts {
  readonly prev: ChannelState | undefined;
  readonly expectedVersion?: bigint;
  readonly allowEqualVersion?: boolean;
  /**
   * When true, sigA/sigB that look like the all-zero placeholder are
   * accepted without verification (used for intermediate single-sig states
   * where one party has not yet co-signed). At least one signature must
   * always verify.
   */
  readonly allowPartialSigs?: boolean;
  /**
   * If set, only the signatures whose corresponding party address appears
   * in this list are verified. Use this to validate just the originating
   * party's sig on intermediate handoff states (the other party will
   * co-sign later or has signed a different state). When omitted, both
   * signatures are required to verify (subject to allowPartialSigs).
   */
  readonly requireSignerAddresses?: readonly Address[];
}

const ZERO_SIG_R = `0x${'00'.repeat(32)}` as `0x${string}`;
const ZERO_SIG_S = `0x${'00'.repeat(32)}` as `0x${string}`;

function isPlaceholderSig(sig: { r: `0x${string}`; s: `0x${string}` }): boolean {
  return sig.r === ZERO_SIG_R && sig.s === ZERO_SIG_S;
}

export async function verifyBothSignatures(
  signed: SignedState,
  ctx: AdmitContext,
  opts: {
    readonly allowPartialSigs?: boolean;
    readonly requireSignerAddresses?: readonly Address[];
  } = {},
): Promise<void> {
  const { channel, chainId, verifyingContract } = ctx;
  const allowPartial = opts.allowPartialSigs === true;
  const required = opts.requireSignerAddresses;
  const requireA =
    required === undefined
      ? true
      : required.some((a) => a.toLowerCase() === channel.userA.toLowerCase());
  const requireB =
    required === undefined
      ? true
      : required.some((a) => a.toLowerCase() === channel.userB.toLowerCase());
  const placeholderA = isPlaceholderSig(signed.sigA);
  const placeholderB = isPlaceholderSig(signed.sigB);

  if (requireA && !(required === undefined && allowPartial && placeholderA)) {
    let okA = false;
    try {
      okA = await verifyChannelStateSignature(
        signed.state,
        sigToHex(signed.sigA),
        channel.userA,
        chainId,
        verifyingContract,
      );
    } catch {
      okA = false;
    }
    if (!okA) {
      throw new StateAdmissionError('BAD_SIGNATURE_A', 'sigA does not verify against userA');
    }
  }

  if (requireB && !(required === undefined && allowPartial && placeholderB)) {
    let okB = false;
    try {
      okB = await verifyChannelStateSignature(
        signed.state,
        sigToHex(signed.sigB),
        channel.userB,
        chainId,
        verifyingContract,
      );
    } catch {
      okB = false;
    }
    if (!okB) {
      throw new StateAdmissionError('BAD_SIGNATURE_B', 'sigB does not verify against userB');
    }
  }

  if (required === undefined && allowPartial && placeholderA && placeholderB) {
    throw new StateAdmissionError(
      'BAD_SIGNATURE_A',
      'state has no valid signatures (both sigA and sigB are placeholders)',
    );
  }
}

export async function admitSignedState(
  signed: SignedState,
  ctx: AdmitContext,
  opts: AdmitSignedStateOpts,
): Promise<void> {
  const { channel } = ctx;
  const { prev, expectedVersion, allowEqualVersion } = opts;

  if (signed.state.channelId !== channel.id) {
    throw new StateAdmissionError(
      'CHANNEL_ID_MISMATCH',
      `state.channelId=${signed.state.channelId} does not match channel.id=${channel.id}`,
    );
  }

  if (channel.status === 'closed') {
    throw new StateAdmissionError(
      'CHANNEL_STATUS_INVALID',
      `cannot accept state for closed channel ${channel.id}`,
    );
  }

  if (expectedVersion !== undefined && signed.state.version !== expectedVersion) {
    if (!(allowEqualVersion === true && signed.state.version === expectedVersion - 1n)) {
      throw new StateAdmissionError(
        'VERSION_NOT_MONOTONIC',
        `state.version=${signed.state.version} does not match expectedVersion=${expectedVersion}`,
      );
    }
  } else if (prev !== undefined) {
    if (allowEqualVersion === true) {
      if (signed.state.version < prev.version) {
        throw new StateAdmissionError(
          'VERSION_NOT_MONOTONIC',
          `state.version=${signed.state.version} is older than prev.version=${prev.version}`,
        );
      }
    } else if (signed.state.version <= prev.version) {
      throw new StateAdmissionError(
        'VERSION_NOT_MONOTONIC',
        `state.version=${signed.state.version} must exceed prev.version=${prev.version}`,
      );
    }
  }

  if (prev !== undefined) {
    const before = computeBalance(prev);
    const after = computeBalance(signed.state);
    if (before.totalA + before.totalB !== after.totalA + after.totalB) {
      throw new StateAdmissionError(
        'BALANCE_NOT_CONSERVED',
        `total channel value changed from ${before.totalA + before.totalB} to ${after.totalA + after.totalB}`,
      );
    }
  }

  await verifyBothSignatures(signed, ctx, {
    ...(opts.allowPartialSigs !== undefined ? { allowPartialSigs: opts.allowPartialSigs } : {}),
    ...(opts.requireSignerAddresses !== undefined
      ? { requireSignerAddresses: opts.requireSignerAddresses }
      : {}),
  });
}

export interface AdmitHtlcOfferOpts extends AdmitSignedStateOpts {
  readonly expectedHtlc: Htlc;
}

export async function admitHtlcOffer(
  signed: SignedState,
  ctx: AdmitContext,
  opts: AdmitHtlcOfferOpts,
): Promise<void> {
  await admitSignedState(signed, ctx, opts);
  const { expectedHtlc } = opts;
  const present = signed.state.htlcs.find((h) => h.id === expectedHtlc.id);
  if (!present) {
    throw new StateAdmissionError(
      'HTLC_NOT_FOUND',
      `expected HTLC id=${expectedHtlc.id} not present in state.htlcs`,
    );
  }
  if (
    present.amount !== expectedHtlc.amount ||
    present.paymentHash !== expectedHtlc.paymentHash ||
    present.expiryMs !== expectedHtlc.expiryMs ||
    present.direction !== expectedHtlc.direction
  ) {
    throw new StateAdmissionError(
      'HTLC_FIELDS_MISMATCH',
      `HTLC id=${expectedHtlc.id} present but with different fields than expected`,
    );
  }
  if (opts.prev !== undefined) {
    const prevHas = opts.prev.htlcs.some((h) => h.id === expectedHtlc.id);
    if (prevHas) {
      throw new StateAdmissionError(
        'EXPECTED_HTLC_PRESENT',
        `HTLC id=${expectedHtlc.id} was already present in prev state`,
      );
    }
  }
}

export interface AdmitHtlcSettleOpts extends AdmitSignedStateOpts {
  readonly htlcId: HtlcId;
  readonly preimage: Preimage;
  readonly expectedPaymentHash?: PaymentHash;
}

export async function admitHtlcSettle(
  signed: SignedState,
  ctx: AdmitContext,
  opts: AdmitHtlcSettleOpts,
): Promise<void> {
  await admitSignedState(signed, ctx, opts);
  const { htlcId, preimage, expectedPaymentHash } = opts;
  const stillPresent = signed.state.htlcs.some((h) => h.id === htlcId);
  if (stillPresent) {
    throw new StateAdmissionError(
      'EXPECTED_HTLC_ABSENT',
      `HTLC id=${htlcId} should be absent in settled state`,
    );
  }
  if (expectedPaymentHash !== undefined && !verifyPreimage(expectedPaymentHash, preimage)) {
    throw new StateAdmissionError(
      'PREIMAGE_MISMATCH',
      'preimage does not hash to expectedPaymentHash',
    );
  }
}

export interface AdmitHtlcFailOpts extends AdmitSignedStateOpts {
  readonly htlcId: HtlcId;
}

export async function admitHtlcFail(
  signed: SignedState,
  ctx: AdmitContext,
  opts: AdmitHtlcFailOpts,
): Promise<void> {
  await admitSignedState(signed, ctx, opts);
  const stillPresent = signed.state.htlcs.some((h) => h.id === opts.htlcId);
  if (stillPresent) {
    throw new StateAdmissionError(
      'EXPECTED_HTLC_ABSENT',
      `HTLC id=${opts.htlcId} should be absent in failed state`,
    );
  }
}

export interface AdmitCloseOpts {
  readonly allowPartialSigs?: boolean;
  readonly requireSignerAddresses?: readonly Address[];
}

export async function admitClose(
  signed: SignedState,
  ctx: AdmitContext,
  opts: AdmitCloseOpts = {},
): Promise<void> {
  if (signed.state.channelId !== ctx.channel.id) {
    throw new StateAdmissionError(
      'CHANNEL_ID_MISMATCH',
      `state.channelId=${signed.state.channelId} does not match channel.id=${ctx.channel.id}`,
    );
  }
  if (!signed.state.finalized) {
    throw new StateAdmissionError('NOT_FINALIZED', 'close state must have finalized=true');
  }
  if (signed.state.htlcs.length > 0) {
    throw new StateAdmissionError(
      'NON_EMPTY_HTLCS',
      'close state must have empty htlcs (cannot close with pending HTLCs)',
    );
  }
  await verifyBothSignatures(signed, ctx, opts);
}

function sigToHex(sig: { r: `0x${string}`; s: `0x${string}`; v: number }): `0x${string}` {
  const v = sig.v.toString(16).padStart(2, '0');
  return `0x${sig.r.slice(2)}${sig.s.slice(2)}${v}` as `0x${string}`;
}
