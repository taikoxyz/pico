import type {
  Address,
  Channel,
  ChannelId,
  ChannelState,
  Hex,
  Htlc,
  HtlcId,
  Signature,
  SignedState,
} from '@tainnel/protocol';
import {
  CHANNEL_STATE_TYPES,
  COOPERATIVE_CLOSE_TYPES,
  type CooperativeClose,
  htlcMerkleRoot,
} from '@tainnel/protocol';
import {
  addHtlc,
  failHtlc,
  settleHtlc,
  verifyCooperativeCloseSignature,
  verifyPreimage,
} from '@tainnel/state-machine';
import { sha256 } from 'viem';
import type { ChainAdapter, ChannelFinalizedReceipt, WaitForFinalizedOptions } from './chain.js';
import {
  CloseRejectedError,
  PaymentRejectedError,
  PaymentTimeoutError,
  UnknownChannelError,
  WaitForFinalizedUnsupportedError,
} from './errors.js';
import type { PaymentRequest, PaymentResult } from './payment.js';
import type { ChannelStorage } from './storage.js';
import { type Transport, type TransportMessage, newRequestId, requestReply } from './transport.js';
import type { WalletAdapter } from './wallet.js';

export interface ChannelClientOptions {
  readonly wallet: WalletAdapter;
  readonly transport: Transport;
  readonly storage: ChannelStorage;
  readonly chain: ChainAdapter;
  readonly hubAddress: Address;
  readonly contract: Address;
  readonly defaultHtlcExpiryMs?: bigint;
  readonly safetyMarginMs?: bigint;
  readonly disputeWindowMs?: number;
  readonly clock?: () => number;
  readonly randomBytes32?: () => Hex;
  readonly subscribeTimeoutMs?: number;
  readonly settleTimeoutMs?: number;
  readonly cooperativeCloseTimeoutMs?: number;
}

export interface OpenChannelArgs {
  readonly counterparty?: Address;
  readonly amount: bigint;
  readonly counterpartyAmount?: bigint;
  readonly token?: Address;
}

export interface BalanceSummary {
  readonly balanceUs: bigint;
  readonly balanceCounterparty: bigint;
  readonly pendingHtlcsTotal: bigint;
}

interface PaymentSettlePayload {
  readonly preimage: Hex;
}

const DEFAULT_HTLC_EXPIRY_MS = 60n * 60n * 1000n;
const DEFAULT_SAFETY_MARGIN_MS = 30n * 1000n;
const DEFAULT_DISPUTE_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SUBSCRIBE_TIMEOUT_MS = 10_000;
const DEFAULT_SETTLE_TIMEOUT_MS = 60_000;
const DEFAULT_COOP_CLOSE_TIMEOUT_MS = 60_000;
const NATIVE_TOKEN: Address = '0x0000000000000000000000000000000000000000';

function emptySig(): Signature {
  return { r: `0x${'00'.repeat(32)}` as Hex, s: `0x${'00'.repeat(32)}` as Hex, v: 0 };
}

function hexToSignature(hex: Hex): Signature {
  if (!hex.startsWith('0x') || hex.length !== 132) {
    throw new Error(`invalid signature hex: ${hex}`);
  }
  return {
    r: `0x${hex.slice(2, 66)}` as Hex,
    s: `0x${hex.slice(66, 130)}` as Hex,
    v: Number.parseInt(hex.slice(130, 132), 16),
  };
}

function signatureToHex(sig: Signature): Hex {
  const r = sig.r.slice(2);
  const s = sig.s.slice(2);
  const v = sig.v.toString(16).padStart(2, '0');
  return `0x${r}${s}${v}` as Hex;
}

export class ChannelClient {
  private readonly opts: ChannelClientOptions;
  private readonly clock: () => number;
  private readonly randomBytes32: () => Hex;

  constructor(opts: ChannelClientOptions) {
    this.opts = opts;
    this.clock = opts.clock ?? (() => Date.now());
    this.randomBytes32 = opts.randomBytes32 ?? defaultRandomBytes32;
  }

  async list(): Promise<readonly Channel[]> {
    return this.opts.storage.list();
  }

  async getBalance(id: ChannelId): Promise<BalanceSummary> {
    const channel = await this.opts.storage.loadChannel(id);
    if (!channel) throw new UnknownChannelError(id);
    const state = await this.opts.storage.loadLatestState(id);
    const me = await this.opts.wallet.getAddress();
    const myAtoB = isUserA(channel, me);
    if (!state) {
      return { balanceUs: 0n, balanceCounterparty: 0n, pendingHtlcsTotal: 0n };
    }
    const balanceUs = myAtoB ? state.state.balanceA : state.state.balanceB;
    const balanceCounterparty = myAtoB ? state.state.balanceB : state.state.balanceA;
    let pendingHtlcsTotal = 0n;
    for (const h of state.state.htlcs) pendingHtlcsTotal += h.amount;
    return { balanceUs, balanceCounterparty, pendingHtlcsTotal };
  }

  async open(args: OpenChannelArgs): Promise<Channel> {
    const counterparty = args.counterparty ?? this.opts.hubAddress;
    const token = args.token ?? NATIVE_TOKEN;
    const counterpartyAmount = args.counterpartyAmount ?? 0n;
    const me = await this.opts.wallet.getAddress();
    const receipt = await this.opts.chain.openChannel({
      contract: this.opts.contract,
      userB: counterparty,
      token,
      amountA: args.amount,
      amountB: counterpartyAmount,
    });
    const channel: Channel = {
      id: receipt.channelId,
      chainId: this.opts.chain.chainId,
      contract: this.opts.contract,
      userA: receipt.userA,
      userB: receipt.userB,
      token: receipt.token,
      status: 'open',
      openedAt: receipt.blockTimestamp,
      disputeWindowMs: this.opts.disputeWindowMs ?? DEFAULT_DISPUTE_WINDOW_MS,
    };

    if (
      channel.userA.toLowerCase() !== me.toLowerCase() &&
      channel.userB.toLowerCase() !== me.toLowerCase()
    ) {
      throw new UnknownChannelError(`channel ${channel.id} does not include wallet ${me}`);
    }

    await this.opts.storage.saveChannel(channel);
    const initialState: SignedState = {
      state: {
        channelId: channel.id,
        version: 0n,
        balanceA: receipt.amountA,
        balanceB: receipt.amountB,
        htlcs: [],
        finalized: false,
      },
      sigA: emptySig(),
      sigB: emptySig(),
    };
    await this.opts.storage.saveState(channel.id, initialState);

    await this.opts.transport.connect();
    await requestReply(
      this.opts.transport,
      { id: newRequestId(), kind: 'subscribe', payload: { channelId: channel.id } },
      {
        replyKind: 'subscribe.ack',
        timeoutMs: this.opts.subscribeTimeoutMs ?? DEFAULT_SUBSCRIBE_TIMEOUT_MS,
      },
    );
    return channel;
  }

  async pay(channelId: ChannelId, request: PaymentRequest): Promise<PaymentResult> {
    const channel = await this.opts.storage.loadChannel(channelId);
    if (!channel) throw new UnknownChannelError(channelId);
    if (channel.status !== 'open') {
      throw new PaymentRejectedError(`channel ${channelId} is not open (status=${channel.status})`);
    }
    const me = await this.opts.wallet.getAddress();
    const direction = isUserA(channel, me) ? 'AtoB' : 'BtoA';
    const prevState = await this.loadOrInitState(channel);
    const preimage = this.randomBytes32();
    const paymentHash = sha256(preimage) as Hex;
    const expiryMs =
      request.expiryMs ??
      BigInt(this.clock()) + (this.opts.defaultHtlcExpiryMs ?? DEFAULT_HTLC_EXPIRY_MS);
    const htlc: Htlc = {
      id: this.randomBytes32() as HtlcId,
      direction,
      amount: request.amount,
      paymentHash,
      expiryMs,
    };
    const nextChannelState: ChannelState = {
      ...addHtlc(prevState.state, htlc),
      version: prevState.state.version + 1n,
    };
    const signedNext = await this.signMyHalfOfState(channel, nextChannelState, prevState);

    // PERSIST BEFORE SEND (D4.3) — if we crash after sign-and-send but before
    // persisting, the hub could later post the new state and we'd be unable to
    // challenge. Always persist, then send.
    await this.opts.storage.saveState(channelId, signedNext);

    const ackP = requestReply<PaymentSettlePayload | { reason: string }>(
      this.opts.transport,
      {
        id: newRequestId(),
        kind: 'pay',
        payload: {
          channelId,
          to: request.to,
          amount: request.amount.toString(),
          memo: request.memo,
          htlc: serializeHtlc(htlc),
          state: serializeSignedState(signedNext),
        },
      },
      { timeoutMs: this.opts.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS },
    );

    let reply: TransportMessage;
    try {
      reply = await ackP;
    } catch (err) {
      if (err instanceof Error && err.name === 'TransportTimeoutError') {
        await this.failPendingHtlcLocally(channel, signedNext, htlc.id);
        throw new PaymentTimeoutError(htlc.id);
      }
      throw err;
    }

    if (reply.kind === 'payment.fail') {
      const reason =
        typeof (reply.payload as { reason?: string })?.reason === 'string'
          ? (reply.payload as { reason: string }).reason
          : 'unknown';
      throw new PaymentRejectedError(reason);
    }
    if (reply.kind !== 'payment.settle') {
      throw new PaymentRejectedError(`unexpected reply kind: ${reply.kind}`);
    }
    const payload = reply.payload as PaymentSettlePayload;
    if (!payload?.preimage || !verifyPreimage(htlc.paymentHash, payload.preimage)) {
      throw new PaymentRejectedError('hub returned an invalid preimage');
    }

    const settledChannelState: ChannelState = {
      ...settleHtlc(signedNext.state, htlc.id, payload.preimage),
      version: signedNext.state.version + 1n,
    };
    const signedSettled = await this.signMyHalfOfState(channel, settledChannelState, signedNext);
    await this.opts.storage.saveState(channelId, signedSettled);

    return {
      channelId,
      preimage: payload.preimage,
      settledAtMs: this.clock(),
      htlcId: htlc.id,
    };
  }

  async close(id: ChannelId, opts: { cooperative?: boolean } = {}): Promise<void> {
    const channel = await this.opts.storage.loadChannel(id);
    if (!channel) throw new UnknownChannelError(id);
    const cooperative = opts.cooperative !== false;
    const latest = await this.opts.storage.loadLatestState(id);
    const channelStatus: Channel['status'] = cooperative
      ? 'closing-cooperative'
      : 'closing-unilateral';
    await this.opts.storage.saveChannel({ ...channel, status: channelStatus });

    if (cooperative) {
      try {
        await this.cooperativeClose(channel, latest);
        await this.opts.storage.saveChannel({ ...channel, status: 'closed' });
        return;
      } catch (err) {
        if (!(err instanceof CloseRejectedError)) throw err;
        await this.unilateralClose(channel, latest);
        await this.opts.storage.saveChannel({ ...channel, status: 'closing-unilateral' });
        return;
      }
    }
    await this.unilateralClose(channel, latest);
  }

  /// Block until the chain emits ChannelFinalized for this channel. Cooperative
  /// closes finalize on receipt; unilateral closes finalize after the dispute
  /// window. Caller decides when to await this. Throws
  /// `WaitForFinalizedUnsupportedError` if the configured ChainAdapter does
  /// not implement it.
  async waitForFinalized(
    id: ChannelId,
    opts?: WaitForFinalizedOptions,
  ): Promise<ChannelFinalizedReceipt> {
    const channel = await this.opts.storage.loadChannel(id);
    if (!channel) throw new UnknownChannelError(id);
    if (typeof this.opts.chain.waitForFinalized !== 'function') {
      throw new WaitForFinalizedUnsupportedError();
    }
    const receipt = await this.opts.chain.waitForFinalized(id, opts);
    await this.opts.storage.saveChannel({ ...channel, status: 'closed' });
    return receipt;
  }

  private async cooperativeClose(channel: Channel, latest?: SignedState): Promise<void> {
    const me = await this.opts.wallet.getAddress();
    const myA = isUserA(channel, me);
    const finalBalanceA = latest?.state.balanceA ?? 0n;
    const finalBalanceB = latest?.state.balanceB ?? 0n;
    const close: CooperativeClose = {
      channelId: channel.id,
      finalBalanceA,
      finalBalanceB,
      signedAt: BigInt(Math.floor(this.clock() / 1000)),
    };
    const mySig = await this.opts.wallet.signTypedData({
      domain: { chainId: this.opts.chain.chainId, verifyingContract: this.opts.contract },
      types: COOPERATIVE_CLOSE_TYPES,
      primaryType: 'CooperativeClose',
      message: {
        channelId: close.channelId,
        finalBalanceA: close.finalBalanceA,
        finalBalanceB: close.finalBalanceB,
        signedAt: close.signedAt,
      },
    });
    const reply = await requestReply<{
      sig: Hex;
      finalBalanceA: string;
      finalBalanceB: string;
      reason?: string;
    }>(
      this.opts.transport,
      {
        id: newRequestId(),
        kind: 'close.request',
        payload: {
          channelId: channel.id,
          close: {
            channelId: close.channelId,
            finalBalanceA: close.finalBalanceA.toString(),
            finalBalanceB: close.finalBalanceB.toString(),
            signedAt: close.signedAt.toString(),
          },
          sig: mySig,
        },
      },
      {
        timeoutMs: this.opts.cooperativeCloseTimeoutMs ?? DEFAULT_COOP_CLOSE_TIMEOUT_MS,
      },
    );
    if (reply.kind === 'close.reject') {
      throw new CloseRejectedError(
        reply.payload && typeof (reply.payload as { reason?: string }).reason === 'string'
          ? (reply.payload as { reason: string }).reason
          : 'rejected',
      );
    }
    if (reply.kind !== 'close.counter') {
      throw new CloseRejectedError(`unexpected reply kind ${reply.kind}`);
    }
    const counterAddress = myA ? channel.userB : channel.userA;
    const sigOk = await verifyCooperativeCloseSignature(
      close,
      reply.payload.sig,
      counterAddress,
      this.opts.chain.chainId,
      this.opts.contract,
    );
    if (!sigOk) {
      throw new CloseRejectedError('counter signature did not verify');
    }
    const finalState: SignedState = {
      state: {
        channelId: channel.id,
        version: (latest?.state.version ?? 0n) + 1n,
        balanceA: finalBalanceA,
        balanceB: finalBalanceB,
        htlcs: [],
        finalized: true,
      },
      sigA: myA ? hexToSignature(mySig) : hexToSignature(reply.payload.sig),
      sigB: myA ? hexToSignature(reply.payload.sig) : hexToSignature(mySig),
    };
    await this.opts.storage.saveState(channel.id, finalState);
    await this.opts.chain.closeCooperative({
      contract: this.opts.contract,
      channelId: channel.id,
      state: finalState,
    });
  }

  private async unilateralClose(channel: Channel, latest?: SignedState): Promise<void> {
    if (!latest) {
      throw new CloseRejectedError('cannot unilaterally close: no signed state on disk');
    }
    const me = await this.opts.wallet.getAddress();
    await this.opts.chain.closeUnilateral({
      contract: this.opts.contract,
      channelId: channel.id,
      state: latest,
      closerSide: isUserA(channel, me) ? 'A' : 'B',
    });
  }

  private async loadOrInitState(channel: Channel): Promise<SignedState> {
    const latest = await this.opts.storage.loadLatestState(channel.id);
    if (latest) return latest;
    const initial: ChannelState = {
      channelId: channel.id,
      version: 0n,
      balanceA: 0n,
      balanceB: 0n,
      htlcs: [],
      finalized: false,
    };
    return { state: initial, sigA: emptySig(), sigB: emptySig() };
  }

  private async signMyHalfOfState(
    channel: Channel,
    state: ChannelState,
    prev: SignedState,
  ): Promise<SignedState> {
    const me = await this.opts.wallet.getAddress();
    const myA = isUserA(channel, me);
    const sig = await this.opts.wallet.signTypedData({
      domain: { chainId: this.opts.chain.chainId, verifyingContract: this.opts.contract },
      types: CHANNEL_STATE_TYPES,
      primaryType: 'ChannelState',
      message: {
        channelId: state.channelId,
        version: state.version,
        balanceA: state.balanceA,
        balanceB: state.balanceB,
        htlcsRoot: htlcMerkleRoot(state.htlcs),
        finalized: state.finalized,
      },
    });
    const sigStruct = hexToSignature(sig);
    return {
      state,
      sigA: myA ? sigStruct : prev.sigA,
      sigB: myA ? prev.sigB : sigStruct,
    };
  }

  private async failPendingHtlcLocally(
    channel: Channel,
    pending: SignedState,
    htlcId: HtlcId,
  ): Promise<void> {
    const failedChannelState: ChannelState = {
      ...failHtlc(pending.state, htlcId),
      version: pending.state.version + 1n,
    };
    const signedFailed = await this.signMyHalfOfState(channel, failedChannelState, pending);
    await this.opts.storage.saveState(channel.id, signedFailed);
  }
}

function isUserA(channel: Channel, address: Address): boolean {
  return channel.userA.toLowerCase() === address.toLowerCase();
}

function defaultRandomBytes32(): Hex {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let hex = '0x';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex as Hex;
}

function serializeHtlc(htlc: Htlc): Record<string, unknown> {
  return {
    id: htlc.id,
    direction: htlc.direction,
    amount: htlc.amount.toString(),
    paymentHash: htlc.paymentHash,
    expiryMs: htlc.expiryMs.toString(),
  };
}

function serializeSignedState(ss: SignedState): Record<string, unknown> {
  return {
    state: {
      channelId: ss.state.channelId,
      version: ss.state.version.toString(),
      balanceA: ss.state.balanceA.toString(),
      balanceB: ss.state.balanceB.toString(),
      htlcs: ss.state.htlcs.map(serializeHtlc),
      finalized: ss.state.finalized,
    },
    sigA: signatureToHex(ss.sigA),
    sigB: signatureToHex(ss.sigB),
  };
}

export const __internal = {
  hexToSignature,
  signatureToHex,
  serializeHtlc,
  serializeSignedState,
};
