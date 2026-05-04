import type { Channel, ChannelState, Htlc, Invoice, Preimage, SignedState } from '@pico/protocol';

export interface InvoiceRecord {
  readonly invoice: Invoice;
  readonly preimage: Preimage;
  readonly consumedAt?: number;
}

interface SerializedHtlc {
  readonly id: string;
  readonly direction: 'AtoB' | 'BtoA';
  readonly amount: string;
  readonly paymentHash: string;
  readonly expiryMs: string;
}

interface SerializedChannelState {
  readonly channelId: string;
  readonly version: string;
  readonly balanceA: string;
  readonly balanceB: string;
  readonly htlcs: readonly SerializedHtlc[];
  readonly finalized: boolean;
}

interface SerializedSignedState {
  readonly state: SerializedChannelState;
  readonly sigA: { r: string; s: string; v: number };
  readonly sigB: { r: string; s: string; v: number };
}

interface SerializedChannel {
  readonly id: string;
  readonly chainId: number;
  readonly contract: string;
  readonly userA: string;
  readonly userB: string;
  readonly token: string;
  readonly status: Channel['status'];
  readonly openedAt: string;
  readonly disputeWindowMs: number;
}

interface SerializedInvoice {
  readonly paymentHash: string;
  readonly amount: string;
  readonly recipient: string;
  readonly expiryMs: string;
  readonly nonce: string;
  readonly memo?: string;
  readonly hubHint?: string;
  readonly signature: string;
}

interface SerializedInvoiceRecord {
  readonly invoice: SerializedInvoice;
  readonly preimage: string;
  readonly consumedAt?: number;
}

function serializeHtlc(htlc: Htlc): SerializedHtlc {
  return {
    id: htlc.id,
    direction: htlc.direction,
    amount: htlc.amount.toString(),
    paymentHash: htlc.paymentHash,
    expiryMs: htlc.expiryMs.toString(),
  };
}

function deserializeHtlc(s: SerializedHtlc): Htlc {
  return {
    id: s.id as Htlc['id'],
    direction: s.direction,
    amount: BigInt(s.amount),
    paymentHash: s.paymentHash as Htlc['paymentHash'],
    expiryMs: BigInt(s.expiryMs),
  };
}

function serializeChannelState(state: ChannelState): SerializedChannelState {
  return {
    channelId: state.channelId,
    version: state.version.toString(),
    balanceA: state.balanceA.toString(),
    balanceB: state.balanceB.toString(),
    htlcs: state.htlcs.map(serializeHtlc),
    finalized: state.finalized,
  };
}

function deserializeChannelState(s: SerializedChannelState): ChannelState {
  return {
    channelId: s.channelId as ChannelState['channelId'],
    version: BigInt(s.version),
    balanceA: BigInt(s.balanceA),
    balanceB: BigInt(s.balanceB),
    htlcs: s.htlcs.map(deserializeHtlc),
    finalized: s.finalized,
  };
}

export function serializeChannel(channel: Channel): SerializedChannel {
  return {
    id: channel.id,
    chainId: channel.chainId,
    contract: channel.contract,
    userA: channel.userA,
    userB: channel.userB,
    token: channel.token,
    status: channel.status,
    openedAt: channel.openedAt.toString(),
    disputeWindowMs: channel.disputeWindowMs,
  };
}

export function deserializeChannel(s: SerializedChannel): Channel {
  return {
    id: s.id as Channel['id'],
    chainId: s.chainId as Channel['chainId'],
    contract: s.contract as Channel['contract'],
    userA: s.userA as Channel['userA'],
    userB: s.userB as Channel['userB'],
    token: s.token as Channel['token'],
    status: s.status,
    openedAt: BigInt(s.openedAt),
    disputeWindowMs: s.disputeWindowMs,
  };
}

export function serializeSignedState(signed: SignedState): SerializedSignedState {
  return {
    state: serializeChannelState(signed.state),
    sigA: { r: signed.sigA.r, s: signed.sigA.s, v: signed.sigA.v },
    sigB: { r: signed.sigB.r, s: signed.sigB.s, v: signed.sigB.v },
  };
}

export function deserializeSignedState(s: SerializedSignedState): SignedState {
  return {
    state: deserializeChannelState(s.state),
    sigA: { r: s.sigA.r as `0x${string}`, s: s.sigA.s as `0x${string}`, v: s.sigA.v },
    sigB: { r: s.sigB.r as `0x${string}`, s: s.sigB.s as `0x${string}`, v: s.sigB.v },
  };
}

export function serializeInvoice(invoice: Invoice): SerializedInvoice {
  return {
    paymentHash: invoice.paymentHash,
    amount: invoice.amount.toString(),
    recipient: invoice.recipient,
    expiryMs: invoice.expiryMs.toString(),
    nonce: invoice.nonce,
    ...(invoice.memo !== undefined ? { memo: invoice.memo } : {}),
    ...(invoice.hubHint !== undefined ? { hubHint: invoice.hubHint } : {}),
    signature: invoice.signature,
  };
}

export function deserializeInvoice(s: SerializedInvoice): Invoice {
  return {
    paymentHash: s.paymentHash as Invoice['paymentHash'],
    amount: BigInt(s.amount),
    recipient: s.recipient as Invoice['recipient'],
    expiryMs: BigInt(s.expiryMs),
    nonce: s.nonce as Invoice['nonce'],
    ...(s.memo !== undefined ? { memo: s.memo } : {}),
    ...(s.hubHint !== undefined ? { hubHint: s.hubHint } : {}),
    signature: s.signature as Invoice['signature'],
  };
}

export function serializeInvoiceRecord(record: InvoiceRecord): SerializedInvoiceRecord {
  return {
    invoice: serializeInvoice(record.invoice),
    preimage: record.preimage,
    ...(record.consumedAt !== undefined ? { consumedAt: record.consumedAt } : {}),
  };
}

export function deserializeInvoiceRecord(s: SerializedInvoiceRecord): InvoiceRecord {
  return {
    invoice: deserializeInvoice(s.invoice),
    preimage: s.preimage as Preimage,
    ...(s.consumedAt !== undefined ? { consumedAt: s.consumedAt } : {}),
  };
}

export type {
  SerializedChannel,
  SerializedSignedState,
  SerializedInvoice,
  SerializedInvoiceRecord,
};
