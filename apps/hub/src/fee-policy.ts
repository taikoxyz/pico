import { DEFAULT_HUB_FEE_BPS, DEFAULT_HUB_FEE_FLAT } from '@inferenceroom/pico-protocol';

export interface FeePolicy {
  quote(amount: bigint): bigint;
}

/**
 * Detailed quote including the privacy-padding component (item 4 of the
 * privacy plan). `senderHtlcAmount` is what the sender locks in the outer
 * HTLC; when `bucket > 0` it is always a multiple of `bucket`, hiding the
 * exact `amount` from passive on-chain observers.
 */
export interface BucketedFeeQuote {
  /** Total fee charged to the sender (baseFee + paddingToBucket). */
  readonly fee: bigint;
  /** Amount delivered to the recipient. Equal to the requested `amount`. */
  readonly outgoingAmount: bigint;
  /** Amount the sender locks in the outer HTLC = amount + fee. */
  readonly senderHtlcAmount: bigint;
  /** Extra value added to the fee to reach the next bucket boundary. */
  readonly paddingToBucket: bigint;
}

export class FlatPlusBpsFeePolicy implements FeePolicy {
  constructor(
    private readonly bps: bigint = DEFAULT_HUB_FEE_BPS,
    private readonly flat: bigint = DEFAULT_HUB_FEE_FLAT,
    private readonly bucket: bigint = 0n,
  ) {
    if (bucket < 0n) throw new Error('FlatPlusBpsFeePolicy: bucket must be non-negative');
  }

  quote(amount: bigint): bigint {
    return this.quoteBucketed(amount).fee;
  }

  quoteBucketed(amount: bigint): BucketedFeeQuote {
    const baseFee = (amount * this.bps) / 10_000n + this.flat;
    let senderHtlc = amount + baseFee;
    let padding = 0n;
    if (this.bucket > 0n) {
      const rem = senderHtlc % this.bucket;
      if (rem !== 0n) {
        padding = this.bucket - rem;
        senderHtlc += padding;
      }
    }
    return {
      fee: baseFee + padding,
      outgoingAmount: amount,
      senderHtlcAmount: senderHtlc,
      paddingToBucket: padding,
    };
  }
}
