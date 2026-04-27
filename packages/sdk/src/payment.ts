import type { Address, ChannelId } from '@tainnel/protocol';

export interface PaymentRequest {
  readonly to: Address;
  readonly amount: bigint;
  readonly viaHub?: string;
  readonly memo?: string;
}

export interface PaymentResult {
  readonly channelId: ChannelId;
  readonly preimage: `0x${string}`;
  readonly settledAtMs: number;
}

export async function pay(_request: PaymentRequest): Promise<PaymentResult> {
  throw new Error('not implemented');
}
