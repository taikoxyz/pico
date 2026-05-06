import type { Address, ChannelId, Hex, Invoice, Preimage } from '@inferenceroom/pico-protocol';

export interface PaymentRequest {
  readonly to?: Address;
  readonly amount?: bigint;
  readonly invoice?: Invoice;
  readonly keysend?: boolean;
  readonly keysendPayload?: Record<string, unknown>;
  readonly recipientEncryptionPubkey?: Hex;
  readonly viaHub?: string;
  readonly memo?: string;
}

export interface PaymentResult {
  readonly channelId: ChannelId;
  readonly preimage: Preimage;
  readonly settledAtMs: number;
}
