import { DEFAULT_HUB_FEE_BPS, DEFAULT_HUB_FEE_FLAT } from '@tainnel/protocol';

export interface FeePolicy {
  quote(amount: bigint): bigint;
}

export class FlatPlusBpsFeePolicy implements FeePolicy {
  constructor(
    private readonly bps: bigint = DEFAULT_HUB_FEE_BPS,
    private readonly flat: bigint = DEFAULT_HUB_FEE_FLAT,
  ) {}

  quote(amount: bigint): bigint {
    return (amount * this.bps) / 10_000n + this.flat;
  }
}
