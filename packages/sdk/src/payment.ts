import type { Address, ChannelId, Hex } from '@tainnel/protocol';

export interface PaymentRequest {
  readonly to: Address;
  readonly amount: bigint;
  readonly viaHub?: string;
  readonly memo?: string;
  readonly expiryMs?: bigint;
}

export interface PaymentResult {
  readonly channelId: ChannelId;
  readonly preimage: Hex;
  readonly settledAtMs: number;
  readonly htlcId: Hex;
}
