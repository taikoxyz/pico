import type {
  Address,
  Channel,
  ChannelId,
  Hex,
  Htlc,
  HtlcId,
  PaymentHash,
  Preimage,
  SignedState,
} from '@tainnel/protocol';

export interface KeysendPayload {
  readonly ciphertext: Hex;
  readonly ephemeralPubkey: Hex;
  readonly nonce: Hex;
}

export interface SubscribeMessage {
  readonly id: string;
  readonly kind: 'subscribe';
  readonly address: Address;
  readonly encryptionPubkey?: Hex;
  readonly channelIds: readonly ChannelId[];
}

export interface SubscribeAckMessage {
  readonly id: string;
  readonly kind: 'subscribeAck';
  readonly sessionId: string;
  readonly channels: readonly Channel[];
  readonly pendingHtlcs: readonly { channelId: ChannelId; htlc: Htlc }[];
}

export interface PayMessage {
  readonly id: string;
  readonly kind: 'pay';
  readonly channelId: ChannelId;
  readonly signedState: SignedState;
  readonly htlc: Htlc;
  readonly paymentHash: PaymentHash;
  readonly recipient: Address;
  readonly amount: bigint;
  readonly keysendPayload?: KeysendPayload;
}

export interface HtlcOfferMessage {
  readonly id: string;
  readonly kind: 'htlcOffer';
  readonly channelId: ChannelId;
  readonly htlc: Htlc;
  readonly signedStateBeforeHtlc: SignedState;
  readonly keysendPayload?: KeysendPayload;
}

export interface HtlcSettleMessage {
  readonly id: string;
  readonly kind: 'htlcSettle';
  readonly channelId: ChannelId;
  readonly htlcId: HtlcId;
  readonly preimage: Preimage;
  readonly signedState: SignedState;
}

export interface HtlcFailMessage {
  readonly id: string;
  readonly kind: 'htlcFail';
  readonly channelId: ChannelId;
  readonly htlcId: HtlcId;
  readonly reason: string;
  readonly signedState?: SignedState;
}

export interface PaymentSettleMessage {
  readonly id: string;
  readonly kind: 'paymentSettle';
  readonly channelId: ChannelId;
  readonly htlcId: HtlcId;
  readonly preimage: Preimage;
  readonly signedStateAfterSettle: SignedState;
}

export interface PaymentFailedMessage {
  readonly id: string;
  readonly kind: 'paymentFailed';
  readonly channelId: ChannelId;
  readonly htlcId: HtlcId;
  readonly reason: string;
}

export interface PayDirectMessage {
  readonly id: string;
  readonly kind: 'payDirect';
  readonly channelId: ChannelId;
  readonly signedState: SignedState;
}

export interface PayDirectAckMessage {
  readonly id: string;
  readonly kind: 'payDirectAck';
  readonly channelId: ChannelId;
  readonly signedState: SignedState;
}

export interface CloseRequestMessage {
  readonly id: string;
  readonly kind: 'closeRequest';
  readonly channelId: ChannelId;
  readonly signedState: SignedState;
}

export interface CloseResponseMessage {
  readonly id: string;
  readonly kind: 'closeResponse';
  readonly channelId: ChannelId;
  readonly signedCloseState: SignedState;
}

export interface ErrorMessage {
  readonly id: string;
  readonly kind: 'error';
  readonly code: string;
  readonly message: string;
  readonly requestId?: string;
}

export type ClientToHubMessage =
  | SubscribeMessage
  | PayMessage
  | PayDirectMessage
  | HtlcSettleMessage
  | HtlcFailMessage
  | CloseRequestMessage;

export type HubToClientMessage =
  | SubscribeAckMessage
  | HtlcOfferMessage
  | PaymentSettleMessage
  | PaymentFailedMessage
  | PayDirectAckMessage
  | CloseResponseMessage
  | ErrorMessage;

export type HubMessage = ClientToHubMessage | HubToClientMessage;

const BIGINT_TAG = '$bigint';

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return { [BIGINT_TAG]: `0x${value.toString(16)}` };
  }
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (
    value !== null &&
    typeof value === 'object' &&
    BIGINT_TAG in value &&
    Object.keys(value).length === 1
  ) {
    const hex = (value as Record<string, unknown>)[BIGINT_TAG];
    if (typeof hex === 'string') return BigInt(hex);
  }
  return value;
}

export function encodeHubMessage(msg: HubMessage): string {
  return JSON.stringify(msg, replacer);
}

export function decodeHubMessage(raw: string): HubMessage {
  const parsed = JSON.parse(raw, reviver);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as { kind?: unknown }).kind !== 'string' ||
    typeof (parsed as { id?: unknown }).id !== 'string'
  ) {
    throw new Error('decodeHubMessage: invalid message shape');
  }
  return parsed as HubMessage;
}
