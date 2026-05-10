import type {
  AcceptTopUpMessage,
  Address,
  Channel,
  ChannelId,
  Hex,
  Htlc,
  HtlcId,
  PaymentHash,
  Preimage,
  ProposeTopUpMessage,
  RejectTopUpMessage,
  SignedCooperativeClose,
  SignedState,
  TopUpCompleteMessage,
} from '@inferenceroom/pico-protocol';

export type {
  TopUpFeePolicy,
  TopUpOfferEnvelope,
  ProposeTopUpMessage,
  AcceptTopUpMessage,
  RejectTopUpMessage,
  TopUpCompleteMessage,
} from '@inferenceroom/pico-protocol';

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
  readonly signedState: SignedState;
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
  readonly signedCooperativeClose: SignedCooperativeClose;
}

export interface CloseResponseMessage {
  readonly id: string;
  readonly kind: 'closeResponse';
  readonly channelId: ChannelId;
  readonly signedCloseState: SignedState;
  readonly signedCooperativeClose: SignedCooperativeClose;
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
  | CloseRequestMessage
  | AcceptTopUpMessage
  | RejectTopUpMessage;

export type HubToClientMessage =
  | SubscribeAckMessage
  | HtlcOfferMessage
  | PaymentSettleMessage
  | PaymentFailedMessage
  | PayDirectAckMessage
  | CloseResponseMessage
  | ErrorMessage
  | ProposeTopUpMessage
  | TopUpCompleteMessage;

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

const KNOWN_KINDS: ReadonlySet<string> = new Set([
  'subscribe',
  'subscribeAck',
  'pay',
  'payDirect',
  'payDirectAck',
  'htlcOffer',
  'htlcSettle',
  'htlcFail',
  'paymentSettle',
  'paymentFailed',
  'closeRequest',
  'closeResponse',
  'error',
  'proposeTopUp',
  'acceptTopUp',
  'rejectTopUp',
  'topUpComplete',
]);

export function decodeHubMessage(raw: string): HubMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw, reviver);
  } catch (err) {
    throw new Error(`decodeHubMessage: invalid JSON (${(err as Error).message})`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('decodeHubMessage: payload is not an object');
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.kind !== 'string') {
    throw new Error('decodeHubMessage: missing or non-string `kind` field');
  }
  if (typeof obj.id !== 'string') {
    throw new Error('decodeHubMessage: missing or non-string `id` field');
  }
  if (!KNOWN_KINDS.has(obj.kind)) {
    throw new Error(`decodeHubMessage: unknown message kind '${obj.kind}'`);
  }
  return parsed as HubMessage;
}
