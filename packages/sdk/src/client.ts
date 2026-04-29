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
  SignedState,
} from '@tainnel/protocol';
import { addHtlc, failHtlc, preimageDigest, settleHtlc } from '@tainnel/state-machine';
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
  private inboundHandlerInstalled = false;
  private myAddress: Address | undefined;
  private readonly hubFeeBps: bigint;
  private readonly hubFeeFlat: bigint;
  private readonly htlcExpiryMs: bigint;
  private readonly safetyMarginMs: bigint;
  private readonly disputeWindowMs: number;
  private readonly closeRequestTimeoutMs: number;
  private readonly settleTimeoutMs: number;

  constructor(private readonly opts: ChannelClientOptions) {
    this.hubFeeBps = opts.hubFeeBps ?? 0n;
    this.hubFeeFlat = opts.hubFeeFlat ?? 0n;
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
      amountB: 0n,
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
  }

  private installInboundHandler(): void {
    if (this.inboundHandlerInstalled) return;
    this.inboundHandlerInstalled = true;
    this.opts.transport.onMessage((msg) => this.handleInbound(msg));
  }

  private async handleInbound(msg: HubToClientMessage): Promise<void> {
    if (msg.kind === 'paymentSettle') {
      const pending = this.inflight.get(msg.htlcId);
      if (pending) {
        this.inflight.delete(msg.htlcId);
        pending.resolve(msg);
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
    this.emitter.emit('htlc:incoming', { channelId: msg.channelId, htlc: msg.htlc });

    const record = await this.opts.storage.loadInvoice(msg.htlc.paymentHash);
    let preimage: Preimage | undefined;
    let direction: 'incoming-invoice' | 'incoming-keysend' | undefined;

    if (record) {
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
    await this.opts.transport.send({
      id: newRequestId('settle'),
      kind: 'htlcSettle',
      channelId: channel.id,
      htlcId: msg.htlc.id,
      preimage,
      signedState,
    });
    if (direction === 'incoming-invoice' && record) {
      await this.opts.storage.markInvoiceConsumed(msg.htlc.paymentHash, Date.now());
    }
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
        const reply = await Promise.race<HubToClientMessage>([
          this.opts.transport.request(
            {
              id: newRequestId('close'),
              kind: 'closeRequest',
              channelId,
              signedState: signed,
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
          await this.opts.chain.closeCooperative({
            channelId,
            finalState: reply.signedCloseState,
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

  private async markClosed(channel: Channel): Promise<void> {
    await this.opts.storage.saveChannel({ ...channel, status: 'closed' });
    this.emitter.emit('channel:closed', { channelId: channel.id });
  }
}

void randomNonce16;
