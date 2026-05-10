import type {
  Address,
  ChainId,
  Channel,
  ChannelId,
  ChannelState,
  CooperativeClose,
  Hex,
  Htlc,
  PaymentHash,
  Preimage,
  Signature,
  SignedCooperativeClose,
  SignedState,
} from '@inferenceroom/pico-protocol';
import { DEFAULT_HUB_FEE_BPS, DEFAULT_HUB_FEE_FLAT } from '@inferenceroom/pico-protocol';
import {
  type StateAdmissionError,
  addHtlc,
  admitClose,
  admitHtlcOffer,
  admitHtlcSettle,
  admitSignedState,
  failHtlc,
  predictTopUpState,
  preimageDigest,
  settleHtlc,
} from '@inferenceroom/pico-state-machine';
import type { Hash } from 'viem';
import type { ChainAdapter } from './chain-adapter.js';
import { randomHtlcId, randomNonce16 } from './crypto.js';
import {
  ChannelNotOpenError,
  HtlcExpiredLocallyError,
  HubTimeoutError,
  PreimageMismatchError,
  UnknownPaymentHashError,
} from './errors.js';
import { type SdkEventMap, TypedEventEmitter } from './events.js';
import type {
  ClientToHubMessage,
  HtlcOfferMessage,
  HubToClientMessage,
  PaymentSettleMessage,
  ProposeTopUpMessage,
} from './hub-protocol.js';
import { type CreatedInvoice, createInvoice, verifyInvoice } from './invoice.js';
import { openSealed, sealForRecipient } from './keysend.js';
import type { PaymentRequest, PaymentResult } from './payment.js';
import { hexToSignature } from './signature-codec.js';
import type { Signer } from './signer.js';
import type { ChannelStorage } from './storage.js';
import type { Transport } from './transport.js';

export interface ChannelClientOptions {
  readonly signer: Signer;
  readonly transport: Transport;
  readonly storage: ChannelStorage;
  readonly chain: ChainAdapter;
  readonly chainId: ChainId;
  readonly verifyingContract: Address;
  readonly hubFeeBps?: bigint;
  readonly hubFeeFlat?: bigint;
  readonly htlcExpiryMs?: bigint;
  readonly safetyMarginMs?: bigint;
  readonly disputeWindowMs?: number;
  readonly defaultToken?: Address;
  readonly encryptionPubkey?: Hex;
  readonly encryptionSecretKey?: Hex;
  readonly closeRequestTimeoutMs?: number;
  readonly settleTimeoutMs?: number;
}

export interface OpenChannelArgs {
  readonly counterparty: Address;
  readonly amount: bigint;
  readonly counterpartyAmount?: bigint;
  readonly token?: Address;
}

const ZERO_SIG: Signature = {
  r: '0x0000000000000000000000000000000000000000000000000000000000000000',
  s: '0x0000000000000000000000000000000000000000000000000000000000000000',
  v: 27,
};

let nextRequestId = 1;
function newRequestId(prefix: string): string {
  return `${prefix}-${Date.now()}-${nextRequestId++}`;
}

interface PendingPayment {
  readonly htlcId: string;
  resolve(msg: PaymentSettleMessage): void;
  reject(err: Error): void;
}

export class ChannelClient {
  private readonly emitter = new TypedEventEmitter<SdkEventMap>();
  private readonly inflight = new Map<string, PendingPayment>();
  private readonly subscribedChannelIds = new Set<ChannelId>();
  private inboundHandlerInstalled = false;
  private reconnectHandlerInstalled = false;
  private myAddress: Address | undefined;
  private readonly hubFeeBps: bigint;
  private readonly hubFeeFlat: bigint;
  private readonly htlcExpiryMs: bigint;
  private readonly safetyMarginMs: bigint;
  private readonly disputeWindowMs: number;
  private readonly closeRequestTimeoutMs: number;
  private readonly settleTimeoutMs: number;

  constructor(private readonly opts: ChannelClientOptions) {
    this.hubFeeBps = opts.hubFeeBps ?? DEFAULT_HUB_FEE_BPS;
    this.hubFeeFlat = opts.hubFeeFlat ?? DEFAULT_HUB_FEE_FLAT;
    this.htlcExpiryMs = opts.htlcExpiryMs ?? 60n * 60n * 1000n;
    this.safetyMarginMs = opts.safetyMarginMs ?? 5n * 60n * 1000n;
    this.disputeWindowMs = opts.disputeWindowMs ?? 24 * 60 * 60 * 1000;
    this.closeRequestTimeoutMs = opts.closeRequestTimeoutMs ?? 60_000;
    this.settleTimeoutMs = opts.settleTimeoutMs ?? 30_000;
  }

  on<E extends keyof SdkEventMap>(event: E, handler: (p: SdkEventMap[E]) => void): () => void {
    return this.emitter.on(event, handler);
  }

  off<E extends keyof SdkEventMap>(event: E, handler: (p: SdkEventMap[E]) => void): void {
    this.emitter.off(event, handler);
  }

  async list(): Promise<readonly Channel[]> {
    return this.opts.storage.list();
  }

  async getBalance(channelId: ChannelId): Promise<{
    balanceUs: bigint;
    balanceCounterparty: bigint;
    pendingHtlcsTotal: bigint;
  }> {
    const channel = await this.opts.storage.loadChannel(channelId);
    if (!channel) throw new Error(`unknown channel ${channelId}`);
    const signed = await this.opts.storage.loadLatestState(channelId);
    const me = await this.address();
    const iAmA = channel.userA.toLowerCase() === me.toLowerCase();
    if (!signed) {
      return { balanceUs: 0n, balanceCounterparty: 0n, pendingHtlcsTotal: 0n };
    }
    const balUs = iAmA ? signed.state.balanceA : signed.state.balanceB;
    const balCp = iAmA ? signed.state.balanceB : signed.state.balanceA;
    const pending = signed.state.htlcs.reduce((acc, h) => acc + h.amount, 0n);
    return { balanceUs: balUs, balanceCounterparty: balCp, pendingHtlcsTotal: pending };
  }

  private async address(): Promise<Address> {
    if (this.myAddress) return this.myAddress;
    this.myAddress = await this.opts.signer.address();
    return this.myAddress;
  }

  async createInvoice(args: {
    amount: bigint;
    expiryMs?: bigint;
    memo?: string;
    hubHint?: string;
  }): Promise<CreatedInvoice> {
    const expiryMs = args.expiryMs ?? BigInt(Date.now()) + this.htlcExpiryMs * 2n;
    const created = await createInvoice(
      {
        amount: args.amount,
        chainId: this.opts.chainId,
        expiryMs,
        ...(args.memo !== undefined ? { memo: args.memo } : {}),
        ...(args.hubHint !== undefined ? { hubHint: args.hubHint } : {}),
      },
      this.opts.signer,
    );
    await this.opts.storage.saveInvoice(created.invoice, created.preimage);
    return created;
  }

  async open(args: OpenChannelArgs): Promise<Channel> {
    const me = await this.address();
    const token = args.token ?? this.opts.defaultToken;
    if (!token) throw new Error('open: token is required (no defaultToken configured)');

    const onChain = await this.opts.chain.openChannel({
      userB: args.counterparty,
      token,
      amountA: args.amount,
      amountB: args.counterpartyAmount ?? 0n,
    });

    const channel: Channel = {
      id: onChain.channelId,
      chainId: this.opts.chainId,
      contract: this.opts.verifyingContract,
      userA: onChain.userA,
      userB: onChain.userB,
      token,
      status: 'open',
      openedAt: onChain.openedAtMs,
      disputeWindowMs: this.disputeWindowMs,
    };
    await this.opts.storage.saveChannel(channel);

    const initialState: ChannelState = {
      channelId: onChain.channelId,
      version: 1n,
      balanceA: onChain.amountA,
      balanceB: onChain.amountB,
      htlcs: [],
      finalized: false,
    };
    const mySig = await this.opts.signer.signChannelState(
      initialState,
      this.opts.chainId,
      this.opts.verifyingContract,
    );
    const iAmA = onChain.userA.toLowerCase() === me.toLowerCase();
    const signedState: SignedState = {
      state: initialState,
      sigA: iAmA ? hexToSignature(mySig) : ZERO_SIG,
      sigB: iAmA ? ZERO_SIG : hexToSignature(mySig),
    };
    await this.opts.storage.saveState(channel.id, signedState);

    await this.ensureSubscribed([channel.id]);
    this.emitter.emit('channel:opened', { channel });
    return channel;
  }

  async ensureSubscribed(channelIds: readonly ChannelId[]): Promise<void> {
    if (!this.opts.transport.isConnected()) await this.opts.transport.connect();
    this.installInboundHandler();
    this.installReconnectHandler();
    for (const id of channelIds) this.subscribedChannelIds.add(id);
    const me = await this.address();
    const subscribeMsg: ClientToHubMessage = {
      id: newRequestId('sub'),
      kind: 'subscribe',
      address: me,
      channelIds,
      ...(this.opts.encryptionPubkey !== undefined
        ? { encryptionPubkey: this.opts.encryptionPubkey }
        : {}),
    };
    const reply = await this.opts.transport.request(subscribeMsg, { timeoutMs: 10_000 });
    if (reply.kind === 'error') {
      throw new Error(`subscribe failed: ${reply.message}`);
    }
    if (reply.kind === 'subscribeAck') {
      // F-02: surface pendingHtlcs reported by the hub. The client may have
      // crashed while these HTLCs were in-flight; emitting them lets a CLI
      // listener pick them up and settle/fail.
      for (const p of reply.pendingHtlcs ?? []) {
        this.emitter.emit('htlc:incoming', { channelId: p.channelId, htlc: p.htlc });
      }
    }
  }

  /**
   * Re-establishes in-memory state from durable storage. Called explicitly
   * by long-running CLIs (`pico listen`, `pico pay --resume`) after a
   * restart so that late settle/fail messages for HTLCs persisted before the
   * crash can still be matched. F-02.
   *
   * The current implementation reconstructs subscribed channel ids from
   * storage and (re)subscribes; pendingHtlcs from the hub flow through
   * `ensureSubscribed`'s `subscribeAck` handler above. In-flight payment
   * promises are not restored across processes — late settle/fail messages
   * become events rather than promise resolutions.
   */
  async recover(): Promise<void> {
    const channels = await this.opts.storage.list();
    if (channels.length === 0) return;
    const ids = channels.map((c) => c.id);
    await this.ensureSubscribed(ids);
  }

  private installInboundHandler(): void {
    if (this.inboundHandlerInstalled) return;
    this.inboundHandlerInstalled = true;
    this.opts.transport.onMessage((msg) => this.handleInbound(msg));
  }

  private installReconnectHandler(): void {
    if (this.reconnectHandlerInstalled) return;
    this.reconnectHandlerInstalled = true;
    this.opts.transport.onReconnect(async () => {
      const ids = Array.from(this.subscribedChannelIds);
      if (ids.length === 0) return;
      try {
        await this.ensureSubscribed(ids);
      } catch (err) {
        this.emitter.emit('error', { error: err as Error, context: 'reconnect resubscribe' });
      }
    });
  }

  private async handleInbound(msg: HubToClientMessage): Promise<void> {
    if (msg.kind === 'paymentSettle') {
      const pending = this.inflight.get(msg.htlcId);
      if (pending) {
        this.inflight.delete(msg.htlcId);
        pending.resolve(msg);
      } else {
        // F-02: late settle for an HTLC whose pay() promise is gone (process
        // restart). Surface as an event so listeners can persist the
        // settled state.
        this.emitter.emit('htlc:settled', {
          channelId: msg.channelId,
          htlc: { id: msg.htlcId } as Htlc,
          preimage: msg.preimage,
          direction: 'outgoing',
        });
      }
      return;
    }
    if (msg.kind === 'paymentFailed') {
      const pending = this.inflight.get(msg.htlcId);
      if (pending) {
        this.inflight.delete(msg.htlcId);
        pending.reject(new Error(`payment failed: ${msg.reason}`));
      }
      return;
    }
    if (msg.kind === 'htlcOffer') {
      try {
        await this.handleHtlcOffer(msg);
      } catch (err) {
        this.emitter.emit('error', { error: err as Error, context: 'htlcOffer' });
      }
      return;
    }
    if (msg.kind === 'proposeTopUp') {
      try {
        await this.handleProposeTopUp(msg);
      } catch (err) {
        this.emitter.emit('error', { error: err as Error, context: 'proposeTopUp' });
      }
      return;
    }
    if (msg.kind === 'topUpComplete') {
      this.emitter.emit('channel:topped-up', {
        channelId: msg.channelId,
        offerId: msg.offerId,
        newVersion: msg.newVersion,
      });
      return;
    }
  }

  private async handleHtlcOffer(msg: HtlcOfferMessage): Promise<void> {
    const me = await this.address();
    const channel = await this.opts.storage.loadChannel(msg.channelId);
    if (!channel) {
      this.emitter.emit('error', {
        error: new Error(`htlcOffer for unknown channel ${msg.channelId}`),
        context: 'htlcOffer',
      });
      return;
    }
    const prev = await this.opts.storage.loadLatestState(msg.channelId);
    const counterparty =
      channel.userA.toLowerCase() === me.toLowerCase() ? channel.userB : channel.userA;
    try {
      await admitHtlcOffer(
        msg.signedStateBeforeHtlc,
        {
          channel,
          chainId: this.opts.chainId,
          verifyingContract: this.opts.verifyingContract,
        },
        {
          prev: prev?.state,
          allowEqualVersion: true,
          allowPartialSigs: true,
          requireSignerAddresses: [counterparty],
          expectedHtlc: msg.htlc,
        },
      );
    } catch (err) {
      const error = err as StateAdmissionError;
      this.emitter.emit('error', {
        error,
        context: `htlcOffer.admit:${error.code ?? 'unknown'}`,
      });
      return;
    }
    this.emitter.emit('htlc:incoming', { channelId: msg.channelId, htlc: msg.htlc });

    const record = await this.opts.storage.loadInvoice(msg.htlc.paymentHash);
    let preimage: Preimage | undefined;
    let direction: 'incoming-invoice' | 'incoming-keysend' | undefined;

    if (record) {
      // F-03: reject replayed invoices (consumed_at marker present).
      if (record.consumedAt !== undefined) {
        await this.failInbound(msg, channel, me, 'invoice already consumed');
        return;
      }
      // F-03: reject expired invoices (signed-by-us; we already trust it,
      // but the local clock may have moved past the expiry).
      const nowMs = BigInt(Date.now());
      if (record.invoice.expiryMs <= nowMs) {
        await this.failInbound(msg, channel, me, 'invoice expired');
        return;
      }
      // F-03: reject HTLCs that expire too soon for safe settlement.
      if (msg.htlc.expiryMs <= nowMs + this.safetyMarginMs) {
        await this.failInbound(msg, channel, me, 'incoming HTLC expires within safety margin');
        return;
      }
      // F-03: reject invoice records whose recipient is not us.
      if (record.invoice.recipient.toLowerCase() !== me.toLowerCase()) {
        await this.failInbound(msg, channel, me, 'invoice recipient is not this signer');
        return;
      }
      if (record.invoice.amount > msg.htlc.amount) {
        await this.failInbound(msg, channel, me, 'amount underpaid');
        return;
      }
      preimage = record.preimage;
      direction = 'incoming-invoice';
    } else if (msg.keysendPayload) {
      if (!this.opts.encryptionSecretKey) {
        await this.failInbound(msg, channel, me, 'no keysend encryption key configured');
        return;
      }
      try {
        const opened = openSealed(msg.keysendPayload, this.opts.encryptionSecretKey);
        const candidate = opened.preimage;
        if (typeof candidate !== 'string') {
          await this.failInbound(msg, channel, me, 'keysend payload missing preimage');
          return;
        }
        if (
          preimageDigest(candidate as Preimage).toLowerCase() !== msg.htlc.paymentHash.toLowerCase()
        ) {
          await this.failInbound(msg, channel, me, 'keysend preimage does not match paymentHash');
          return;
        }
        preimage = candidate as Preimage;
        direction = 'incoming-keysend';
      } catch (err) {
        await this.failInbound(
          msg,
          channel,
          me,
          `keysend decrypt failed: ${(err as Error).message}`,
        );
        return;
      }
    } else {
      const error = new UnknownPaymentHashError(msg.htlc.paymentHash);
      this.emitter.emit('htlc:failed', {
        channelId: msg.channelId,
        htlc: msg.htlc,
        reason: error.message,
      });
      await this.failInbound(msg, channel, me, error.message);
      return;
    }

    if (!preimage) return;
    const settled = settleHtlc(msg.signedStateBeforeHtlc.state, msg.htlc.id, preimage);
    const newState: ChannelState = { ...settled, version: settled.version + 1n };
    const mySig = await this.opts.signer.signChannelState(
      newState,
      this.opts.chainId,
      this.opts.verifyingContract,
    );
    const iAmA = channel.userA.toLowerCase() === me.toLowerCase();
    const signedState: SignedState = {
      state: newState,
      sigA: iAmA ? hexToSignature(mySig) : msg.signedStateBeforeHtlc.sigA,
      sigB: iAmA ? msg.signedStateBeforeHtlc.sigB : hexToSignature(mySig),
    };
    await this.opts.storage.saveState(channel.id, signedState);
    if (direction === 'incoming-invoice' && record) {
      await this.opts.storage.markInvoiceConsumed(msg.htlc.paymentHash, Date.now());
    }
    await this.opts.transport.send({
      id: newRequestId('settle'),
      kind: 'htlcSettle',
      channelId: channel.id,
      htlcId: msg.htlc.id,
      preimage,
      signedState,
    });
    this.emitter.emit('htlc:settled', {
      channelId: channel.id,
      htlc: msg.htlc,
      preimage,
      direction: 'incoming',
    });
  }

  private async failInbound(
    msg: HtlcOfferMessage,
    channel: Channel,
    me: Address,
    reason: string,
  ): Promise<void> {
    const failed = failHtlc(msg.signedStateBeforeHtlc.state, msg.htlc.id);
    const newState: ChannelState = { ...failed, version: failed.version + 1n };
    const mySig = await this.opts.signer.signChannelState(
      newState,
      this.opts.chainId,
      this.opts.verifyingContract,
    );
    const iAmA = channel.userA.toLowerCase() === me.toLowerCase();
    const signedState: SignedState = {
      state: newState,
      sigA: iAmA ? hexToSignature(mySig) : msg.signedStateBeforeHtlc.sigA,
      sigB: iAmA ? msg.signedStateBeforeHtlc.sigB : hexToSignature(mySig),
    };
    await this.opts.storage.saveState(channel.id, signedState);
    await this.opts.transport.send({
      id: newRequestId('fail'),
      kind: 'htlcFail',
      channelId: channel.id,
      htlcId: msg.htlc.id,
      reason,
      signedState,
    });
    this.emitter.emit('htlc:failed', {
      channelId: channel.id,
      htlc: msg.htlc,
      reason,
    });
  }

  /**
   * Direct (non-HTLC) balance update. Atomic 2-party transfer of `amount` from
   * the caller to the channel counterparty. No preimage, no expiry — the
   * payment is final the moment the hub returns a counter-signed state.
   *
   * Requires no in-flight HTLCs in the channel; otherwise the merkle root
   * would not match the contract's `htlcsRoot == bytes32(0)` invariant for
   * cooperative close.
   */
  async payDirect(
    channelId: ChannelId,
    args: { amount: bigint },
  ): Promise<{ channelId: ChannelId; version: bigint }> {
    if (args.amount <= 0n) throw new Error('payDirect: amount must be positive');
    const me = await this.address();
    const channel = await this.opts.storage.loadChannel(channelId);
    if (!channel) throw new Error(`unknown channel ${channelId}`);
    if (channel.status !== 'open') throw new ChannelNotOpenError(channelId, channel.status);
    const signed = await this.opts.storage.loadLatestState(channelId);
    if (!signed) throw new Error(`no signed state for channel ${channelId}`);
    if (signed.state.htlcs.length > 0) {
      throw new Error('payDirect: in-flight HTLCs present; settle or fail them first');
    }

    const iAmA = channel.userA.toLowerCase() === me.toLowerCase();
    const myBalance = iAmA ? signed.state.balanceA : signed.state.balanceB;
    if (myBalance < args.amount) {
      throw new Error(`payDirect: insufficient balance (have ${myBalance}, need ${args.amount})`);
    }

    const newState: ChannelState = {
      ...signed.state,
      version: signed.state.version + 1n,
      balanceA: iAmA ? signed.state.balanceA - args.amount : signed.state.balanceA + args.amount,
      balanceB: iAmA ? signed.state.balanceB + args.amount : signed.state.balanceB - args.amount,
    };

    const mySig = await this.opts.signer.signChannelState(
      newState,
      this.opts.chainId,
      this.opts.verifyingContract,
    );
    const lockedSigned: SignedState = {
      state: newState,
      sigA: iAmA ? hexToSignature(mySig) : signed.sigA,
      sigB: iAmA ? signed.sigB : hexToSignature(mySig),
    };
    await this.opts.storage.saveState(channelId, lockedSigned);

    const reply = await this.opts.transport.request(
      {
        id: newRequestId('payDirect'),
        kind: 'payDirect',
        channelId,
        signedState: lockedSigned,
      },
      { timeoutMs: this.settleTimeoutMs },
    );
    if (reply.kind === 'error') {
      throw new Error(`payDirect rejected: ${reply.message}`);
    }
    if (reply.kind !== 'payDirectAck') {
      throw new Error(`payDirect: unexpected reply kind '${reply.kind}'`);
    }
    if (reply.signedState.state.version !== newState.version) {
      throw new Error(
        `payDirect: hub acked wrong version (sent ${newState.version}, got ${reply.signedState.state.version})`,
      );
    }
    const counterpartyDirect =
      channel.userA.toLowerCase() === me.toLowerCase() ? channel.userB : channel.userA;
    await admitSignedState(
      reply.signedState,
      {
        channel,
        chainId: this.opts.chainId,
        verifyingContract: this.opts.verifyingContract,
      },
      {
        prev: signed.state,
        expectedVersion: newState.version,
        allowPartialSigs: true,
        requireSignerAddresses: [counterpartyDirect],
      },
    );
    if (
      reply.signedState.state.balanceA !== newState.balanceA ||
      reply.signedState.state.balanceB !== newState.balanceB
    ) {
      throw new Error('payDirect: hub-acked balances do not match the state we signed');
    }
    await this.opts.storage.saveState(channelId, reply.signedState);
    return { channelId, version: newState.version };
  }

  async pay(req: PaymentRequest): Promise<PaymentResult> {
    const me = await this.address();
    if (req.invoice) {
      await verifyInvoice(req.invoice, { chainId: this.opts.chainId });
    }
    const recipient = req.invoice?.recipient ?? req.to;
    if (!recipient) throw new Error('pay: invoice or {to} required');
    const baseAmount = req.invoice?.amount ?? req.amount;
    if (baseAmount === undefined) throw new Error('pay: invoice or {amount} required');

    const channel = await this.findChannelTo(recipient);
    if (!channel) throw new ChannelNotOpenError(recipient, 'no open channel');
    const signed = await this.opts.storage.loadLatestState(channel.id);
    if (!signed) throw new Error(`no signed state for channel ${channel.id}`);

    const fee = (baseAmount * this.hubFeeBps) / 10_000n + this.hubFeeFlat;
    const totalAmount = baseAmount + fee;
    const iAmA = channel.userA.toLowerCase() === me.toLowerCase();
    const direction: 'AtoB' | 'BtoA' = iAmA ? 'AtoB' : 'BtoA';

    let preimage: Preimage;
    let paymentHash: PaymentHash;
    let keysendPayload: ReturnType<typeof sealForRecipient> | undefined;
    if (req.invoice) {
      paymentHash = req.invoice.paymentHash;
      preimage = '0x' as Preimage; // populated on settle
    } else if (req.keysend) {
      if (!req.recipientEncryptionPubkey) {
        throw new Error('pay({keysend}): recipientEncryptionPubkey is required');
      }
      const { randomPreimage } = await import('./crypto.js');
      preimage = randomPreimage();
      paymentHash = preimageDigest(preimage);
      keysendPayload = sealForRecipient(
        {
          preimage,
          ...(req.keysendPayload ?? {}),
          ...(req.memo !== undefined ? { memo: req.memo } : {}),
        },
        req.recipientEncryptionPubkey,
      );
    } else {
      throw new Error('pay: either {invoice} or {keysend: true} is required');
    }

    const expiryMs = BigInt(Date.now()) + this.htlcExpiryMs;
    const htlc: Htlc = {
      id: randomHtlcId(),
      direction,
      amount: totalAmount,
      paymentHash,
      expiryMs,
    };

    const lockedState = addHtlc(signed.state, htlc);
    const newState: ChannelState = { ...lockedState, version: lockedState.version + 1n };
    const mySig = await this.opts.signer.signChannelState(
      newState,
      this.opts.chainId,
      this.opts.verifyingContract,
    );
    const lockedSigned: SignedState = {
      state: newState,
      sigA: iAmA ? hexToSignature(mySig) : signed.sigA,
      sigB: iAmA ? signed.sigB : hexToSignature(mySig),
    };
    await this.opts.storage.saveState(channel.id, lockedSigned); // PERSIST BEFORE SEND

    const settlePromise = new Promise<PaymentSettleMessage>((resolve, reject) => {
      this.inflight.set(htlc.id, { htlcId: htlc.id, resolve, reject });
    });

    const reqMsg: ClientToHubMessage = {
      id: newRequestId('pay'),
      kind: 'pay',
      channelId: channel.id,
      signedState: lockedSigned,
      htlc,
      paymentHash,
      recipient,
      amount: totalAmount,
      ...(keysendPayload !== undefined ? { keysendPayload } : {}),
    };
    await this.opts.transport.send(reqMsg);

    const safety = Number(this.safetyMarginMs);
    const remainingMs = Math.max(
      Number(this.settleTimeoutMs),
      Math.min(Number(htlc.expiryMs - BigInt(Date.now())) - safety, Number(this.htlcExpiryMs)),
    );
    let settled: PaymentSettleMessage;
    try {
      settled = await Promise.race([
        settlePromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new HtlcExpiredLocallyError(htlc.id)), remainingMs),
        ),
      ]);
    } catch (err) {
      this.inflight.delete(htlc.id);
      const failedState = failHtlc(newState, htlc.id);
      const failedNext: ChannelState = { ...failedState, version: failedState.version + 1n };
      const failSig = await this.opts.signer.signChannelState(
        failedNext,
        this.opts.chainId,
        this.opts.verifyingContract,
      );
      const failedSigned: SignedState = {
        state: failedNext,
        sigA: iAmA ? hexToSignature(failSig) : lockedSigned.sigA,
        sigB: iAmA ? lockedSigned.sigB : hexToSignature(failSig),
      };
      await this.opts.storage.saveState(channel.id, failedSigned);
      await this.opts.transport.send({
        id: newRequestId('fail'),
        kind: 'htlcFail',
        channelId: channel.id,
        htlcId: htlc.id,
        reason: (err as Error).message,
        signedState: failedSigned,
      });
      this.emitter.emit('htlc:failed', {
        channelId: channel.id,
        htlc,
        reason: (err as Error).message,
      });
      throw err;
    }

    if (preimageDigest(settled.preimage).toLowerCase() !== paymentHash.toLowerCase()) {
      throw new PreimageMismatchError();
    }
    const counterpartySettle =
      channel.userA.toLowerCase() === me.toLowerCase() ? channel.userB : channel.userA;
    await admitHtlcSettle(
      settled.signedStateAfterSettle,
      {
        channel,
        chainId: this.opts.chainId,
        verifyingContract: this.opts.verifyingContract,
      },
      {
        prev: lockedSigned.state,
        allowEqualVersion: true,
        allowPartialSigs: true,
        requireSignerAddresses: [counterpartySettle],
        htlcId: htlc.id,
        preimage: settled.preimage,
        expectedPaymentHash: paymentHash,
      },
    );
    const settledState = settleHtlc(newState, htlc.id, settled.preimage);
    const settledNext: ChannelState = { ...settledState, version: settledState.version + 1n };
    const settledSig = await this.opts.signer.signChannelState(
      settledNext,
      this.opts.chainId,
      this.opts.verifyingContract,
    );
    const settledSigned: SignedState = {
      state: settledNext,
      sigA: iAmA ? hexToSignature(settledSig) : settled.signedStateAfterSettle.sigA,
      sigB: iAmA ? settled.signedStateAfterSettle.sigB : hexToSignature(settledSig),
    };
    await this.opts.storage.saveState(channel.id, settledSigned);
    this.emitter.emit('htlc:settled', {
      channelId: channel.id,
      htlc,
      preimage: settled.preimage,
      direction: 'outgoing',
    });
    return {
      channelId: channel.id,
      preimage: settled.preimage,
      settledAtMs: Date.now(),
    };
  }

  private async findChannelTo(counterparty: Address): Promise<Channel | undefined> {
    const cp = counterparty.toLowerCase();
    for (const c of await this.opts.storage.list()) {
      if (c.status !== 'open') continue;
      if (c.userA.toLowerCase() === cp || c.userB.toLowerCase() === cp) return c;
    }
    for (const c of await this.opts.storage.list()) {
      if (c.status === 'open') return c;
    }
    return undefined;
  }

  async close(channelId: ChannelId, opts: { cooperative?: boolean } = {}): Promise<void> {
    const channel = await this.opts.storage.loadChannel(channelId);
    if (!channel) throw new Error(`unknown channel ${channelId}`);
    const signed = await this.opts.storage.loadLatestState(channelId);
    if (!signed) throw new Error(`no signed state for channel ${channelId}`);

    const me = await this.address();
    const iAmA = channel.userA.toLowerCase() === me.toLowerCase();

    const cooperative = opts.cooperative !== false;
    if (cooperative) {
      try {
        if (signed.state.htlcs.length > 0) {
          throw new Error('cooperative close requires no in-flight HTLCs');
        }
        const finalState: ChannelState = {
          ...signed.state,
          version: signed.state.version + 1n,
          finalized: true,
        };
        const nowSec = BigInt(Math.floor(Date.now() / 1000));
        const close: CooperativeClose = {
          channelId,
          version: finalState.version,
          finalBalanceA: finalState.balanceA,
          finalBalanceB: finalState.balanceB,
          signedAt: nowSec,
          validUntil: nowSec + 3600n,
        };
        const mySig = await this.opts.signer.signChannelState(
          finalState,
          this.opts.chainId,
          this.opts.verifyingContract,
        );
        const myCloseSig = await this.opts.signer.signCooperativeClose(
          close,
          this.opts.chainId,
          this.opts.verifyingContract,
        );
        const myCloseSignature = hexToSignature(myCloseSig);
        const finalSigned: SignedState = {
          state: finalState,
          sigA: iAmA ? hexToSignature(mySig) : signed.sigA,
          sigB: iAmA ? signed.sigB : hexToSignature(mySig),
        };
        const signedCooperativeClose: SignedCooperativeClose = {
          close,
          sigA: myCloseSignature,
          sigB: myCloseSignature,
        };

        const reply = await Promise.race<HubToClientMessage>([
          this.opts.transport.request(
            {
              id: newRequestId('close'),
              kind: 'closeRequest',
              channelId,
              signedState: finalSigned,
              signedCooperativeClose,
            },
            { timeoutMs: this.closeRequestTimeoutMs },
          ),
          new Promise<HubToClientMessage>((_, reject) =>
            setTimeout(
              () => reject(new HubTimeoutError('closeRequest', this.closeRequestTimeoutMs)),
              this.closeRequestTimeoutMs + 50,
            ),
          ),
        ]);
        if (reply.kind === 'closeResponse') {
          const me = await this.address();
          const counterpartyClose =
            channel.userA.toLowerCase() === me.toLowerCase() ? channel.userB : channel.userA;
          await admitClose(
            reply.signedCloseState,
            {
              channel,
              chainId: this.opts.chainId,
              verifyingContract: this.opts.verifyingContract,
            },
            { allowPartialSigs: true, requireSignerAddresses: [counterpartyClose] },
          );
          await this.opts.storage.saveState(channelId, reply.signedCloseState);
          await this.opts.chain.closeCooperative({
            channelId,
            signedClose: reply.signedCooperativeClose,
          });
          await this.markClosed(channel);
          return;
        }
      } catch (err) {
        this.emitter.emit('error', { error: err as Error, context: 'closeRequest fallback' });
      }
    }

    await this.opts.chain.closeUnilateral({
      channelId,
      state: signed,
      mySide: iAmA ? 'A' : 'B',
    });
    await this.opts.storage.saveChannel({ ...channel, status: 'closing-unilateral' });
    void this.opts.chain
      .waitForFinalized(channelId, { timeoutMs: 5 * 60_000 })
      .then(() => this.markClosed(channel))
      .catch((err) => {
        this.emitter.emit('error', { error: err as Error, context: 'waitForFinalized' });
      });
    this.emitter.emit('channel:closed', { channelId });
  }

  /**
   * Submit `closeUnilateralFromOpen(channelId)` for a freshly-opened channel
   * with no dual-signed off-chain state. The contract uses the implicit
   * version-0 state derived from the channel's funded amounts and starts the
   * 24-hour dispute window. See protocol-spec §1 / §5.2.
   */
  async closeUnilateralFromOpen(
    channelId: ChannelId,
  ): Promise<{ disputeDeadlineMs: bigint; txHash: Hash }> {
    const channel = await this.opts.storage.loadChannel(channelId);
    if (!channel) throw new Error(`unknown channel ${channelId}`);
    const result = await this.opts.chain.closeUnilateralFromOpen({ channelId });
    await this.opts.storage.saveChannel({ ...channel, status: 'closing-unilateral' });
    void this.opts.chain
      .waitForFinalized(channelId, { timeoutMs: 5 * 60_000 })
      .then(() => this.markClosed(channel))
      .catch((err) => {
        this.emitter.emit('error', { error: err as Error, context: 'waitForFinalized' });
      });
    this.emitter.emit('channel:closed', { channelId });
    return { disputeDeadlineMs: result.disputeDeadlineMs, txHash: result.txHash };
  }

  /**
   * Depositor-initiated top-up. Submits `topUp(channelId, amount, prev, next)`
   * on-chain. Both `prev` and `next` MUST already be dual-signed by the
   * channel's userA and userB; this method does NOT perform off-chain
   * co-signing (that requires a partner WS handshake — use `proposeTopUp`
   * from the hub side, or carry your own out-of-band co-signing flow).
   *
   * For the very first top-up on a channel with no dual-signed state, pass a
   * synthetic `prev` carrying `version: 0n`, the current on-chain
   * `amountA`/`amountB` as balances, and zero-sentinel signatures
   * (`EMPTY_SIG_BYTES`-derived). See protocol-spec §8.3.
   */
  async topUp(
    channelId: ChannelId,
    amount: bigint,
    opts: { prev: SignedState; next: SignedState; approve?: boolean },
  ): Promise<{ newVersion: bigint; txHash: Hash }> {
    const channel = await this.opts.storage.loadChannel(channelId);
    if (!channel) throw new Error(`unknown channel ${channelId}`);
    const result = await this.opts.chain.topUp({
      channelId,
      amount,
      prev: opts.prev,
      next: opts.next,
      token: channel.token,
      ...(opts.approve !== undefined ? { approve: opts.approve } : {}),
    });
    await this.opts.storage.saveState(channelId, opts.next);
    return { newVersion: result.newVersion, txHash: result.txHash };
  }

  /**
   * Handle an incoming `proposeTopUp` from the hub: validate the offer
   * envelope against local state, co-sign the proposed `newState`, and reply
   * with `acceptTopUp`. On any failure, replies with `rejectTopUp`.
   */
  private async handleProposeTopUp(msg: ProposeTopUpMessage): Promise<void> {
    try {
      const channel = await this.opts.storage.loadChannel(msg.channelId);
      if (!channel) {
        await this.sendRejectTopUp(msg, 'unknown channel');
        return;
      }
      const me = await this.address();
      const iAmA = channel.userA.toLowerCase() === me.toLowerCase();

      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      if (msg.validUntil < nowSec) {
        await this.sendRejectTopUp(msg, 'offer expired');
        return;
      }

      const latest = await this.opts.storage.loadLatestState(msg.channelId);
      const localVersion = latest?.state.version ?? 0n;
      if (msg.prevStateVersion !== localVersion) {
        await this.sendRejectTopUp(
          msg,
          `prev version mismatch (got ${msg.prevStateVersion}, local ${localVersion})`,
        );
        return;
      }

      // Build prev for prediction: latest dual-signed state if we have one,
      // else infer pre-top-up balances by subtracting `amount` from the side
      // the hub is depositing into (= our counterparty side).
      const hubSide: 'A' | 'B' = iAmA ? 'B' : 'A';
      const prevState: ChannelState = latest?.state ?? {
        channelId: msg.channelId,
        version: 0n,
        balanceA: hubSide === 'A' ? msg.newState.balanceA - msg.amount : msg.newState.balanceA,
        balanceB: hubSide === 'B' ? msg.newState.balanceB - msg.amount : msg.newState.balanceB,
        htlcs: [],
        finalized: false,
      };

      let expected: ChannelState;
      try {
        expected = predictTopUpState(prevState, hubSide, msg.amount);
      } catch (err) {
        await this.sendRejectTopUp(msg, `predictTopUpState failed: ${(err as Error).message}`);
        return;
      }
      if (
        expected.version !== msg.newState.version ||
        expected.balanceA !== msg.newState.balanceA ||
        expected.balanceB !== msg.newState.balanceB ||
        expected.channelId !== msg.newState.channelId ||
        expected.finalized !== msg.newState.finalized ||
        expected.htlcs.length !== msg.newState.htlcs.length
      ) {
        await this.sendRejectTopUp(msg, 'proposed newState does not match prediction');
        return;
      }

      const mySigHex = await this.opts.signer.signChannelState(
        msg.newState,
        this.opts.chainId,
        this.opts.verifyingContract,
      );
      const mySig = hexToSignature(mySigHex);
      const hubSig = hexToSignature(msg.newSig);
      const signedNewState: SignedState = {
        state: msg.newState,
        sigA: iAmA ? mySig : hubSig,
        sigB: iAmA ? hubSig : mySig,
      };

      await this.opts.transport.send({
        id: newRequestId('acceptTopUp'),
        kind: 'acceptTopUp',
        channelId: msg.channelId,
        offerId: msg.offerId,
        signedNewState,
      });
    } catch (err) {
      await this.sendRejectTopUp(msg, (err as Error).message);
    }
  }

  private async sendRejectTopUp(msg: ProposeTopUpMessage, reason: string): Promise<void> {
    await this.opts.transport.send({
      id: newRequestId('rejectTopUp'),
      kind: 'rejectTopUp',
      channelId: msg.channelId,
      offerId: msg.offerId,
      reason,
    });
  }

  private async markClosed(channel: Channel): Promise<void> {
    await this.opts.storage.saveChannel({ ...channel, status: 'closed' });
    this.emitter.emit('channel:closed', { channelId: channel.id });
  }
}

void randomNonce16;
