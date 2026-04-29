import type {
  Address,
  ChainId,
  ChannelId,
  CooperativeClose,
  Hex,
  Htlc,
  HtlcId,
  Signature,
  SignedState,
} from '@tainnel/protocol';
import { COOPERATIVE_CLOSE_TYPES, buildDomain, htlcMerkleRoot } from '@tainnel/protocol';
import {
  verifyChannelStateSignature,
  verifyCooperativeCloseSignature,
} from '@tainnel/state-machine';
import { privateKeyToAccount } from 'viem/accounts';
import type { ChannelPool } from '../channel-pool.js';
import type { Repositories } from '../db/index.js';
import type { Logger } from '../logger.js';
import { disputesTotal, htlcsInFlight, paymentsTotal } from '../metrics.js';
import type { PreimageRegistry } from '../preimage-registry.js';

export interface WsMessage {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
}

export interface WsHandlerDeps {
  readonly hubPrivateKey: Hex;
  readonly chainId: ChainId;
  readonly verifyingContract: Address;
  readonly channelPool: ChannelPool;
  readonly repos: Repositories;
  readonly preimages: PreimageRegistry;
  readonly logger: Logger;
}

interface PaySerializedHtlc {
  id: Hex;
  direction: 'AtoB' | 'BtoA';
  amount: string;
  paymentHash: Hex;
  expiryMs: string;
}

interface PaySerializedSignedState {
  state: {
    channelId: ChannelId;
    version: string;
    balanceA: string;
    balanceB: string;
    htlcs: PaySerializedHtlc[];
    finalized: boolean;
  };
  sigA: Hex;
  sigB: Hex;
}

interface PayPayload {
  channelId: ChannelId;
  to?: Address;
  amount?: string;
  memo?: string;
  htlc: PaySerializedHtlc;
  state: PaySerializedSignedState;
}

interface CloseRequestPayload {
  channelId: ChannelId;
  close: {
    channelId: ChannelId;
    finalBalanceA: string;
    finalBalanceB: string;
    signedAt: string;
  };
  sig: Hex;
}

export class HubMessageHandler {
  private readonly account: ReturnType<typeof privateKeyToAccount>;

  constructor(private readonly deps: WsHandlerDeps) {
    this.account = privateKeyToAccount(deps.hubPrivateKey);
  }

  async handle(msg: WsMessage): Promise<WsMessage | undefined> {
    switch (msg.kind) {
      case 'subscribe':
        return this.handleSubscribe(msg);
      case 'pay':
        return this.handlePay(msg);
      case 'close.request':
        return this.handleCloseRequest(msg);
      case 'ping':
        return { id: msg.id, kind: 'pong', payload: null };
      default:
        return undefined;
    }
  }

  private handleSubscribe(msg: WsMessage): WsMessage {
    return { id: msg.id, kind: 'subscribe.ack', payload: { ok: true } };
  }

  private async handlePay(msg: WsMessage): Promise<WsMessage> {
    const fail = (reason: string): WsMessage => {
      paymentsTotal.inc({ status: 'failed' });
      return { id: msg.id, kind: 'payment.fail', payload: { reason } };
    };
    const payload = msg.payload as PayPayload;
    if (!payload?.channelId) return fail('missing channelId');
    if (!payload.htlc?.paymentHash) return fail('missing paymentHash');
    if (!payload.state) return fail('missing state');

    return this.deps.channelPool.withLock(payload.channelId, async () => {
      const channel = this.deps.channelPool.get(payload.channelId);
      if (!channel) return fail('unknown channel');
      const signed = deserializePayState(payload.state);
      const root = htlcMerkleRoot(signed.state.htlcs);
      const sigOkPayer = await verifyChannelStateSignature(
        signed.state,
        payload.state.sigA,
        channel.userA,
        channel.chainId,
        channel.contract,
      );
      const sigOkPayee = await verifyChannelStateSignature(
        signed.state,
        payload.state.sigB,
        channel.userB,
        channel.chainId,
        channel.contract,
      );
      if (!(sigOkPayer || sigOkPayee)) {
        return fail('state not signed by either party');
      }
      // record signed state (rejects if version not strictly newer than known)
      try {
        this.deps.channelPool.recordState(payload.channelId, signed);
      } catch (err) {
        return fail((err as Error).message);
      }
      // persist payment + htlc
      this.deps.repos.payments.start({
        id: payload.htlc.id as HtlcId,
        sourceChannel: payload.channelId,
        amount: BigInt(payload.htlc.amount),
        paymentHash: payload.htlc.paymentHash,
      });
      this.deps.repos.htlcs.upsert({
        id: payload.htlc.id,
        channelId: payload.channelId,
        paymentHash: payload.htlc.paymentHash,
        amount: BigInt(payload.htlc.amount),
        expiryMs: BigInt(payload.htlc.expiryMs),
        direction: payload.htlc.direction,
        status: 'pending',
        createdAt: Date.now(),
      });
      htlcsInFlight.inc();

      // settle if we know a preimage
      const preimage = this.deps.preimages.get(payload.htlc.paymentHash);
      if (!preimage) {
        this.deps.repos.payments.fail(payload.htlc.id as HtlcId);
        this.deps.repos.htlcs.setStatus(payload.htlc.id, 'failed');
        htlcsInFlight.dec();
        return fail('no preimage registered for paymentHash');
      }
      this.deps.repos.payments.complete(payload.htlc.id as HtlcId, 0n);
      this.deps.repos.htlcs.setStatus(payload.htlc.id, 'settled', preimage);
      htlcsInFlight.dec();
      paymentsTotal.inc({ status: 'settled' });
      void root;
      return {
        id: msg.id,
        kind: 'payment.settle',
        payload: { preimage },
      };
    });
  }

  private async handleCloseRequest(msg: WsMessage): Promise<WsMessage> {
    const reject = (reason: string): WsMessage => ({
      id: msg.id,
      kind: 'close.reject',
      payload: { reason },
    });
    const payload = msg.payload as CloseRequestPayload;
    if (!payload?.channelId) return reject('missing channelId');
    const channel = this.deps.channelPool.get(payload.channelId);
    if (!channel) return reject('unknown channel');
    const close: CooperativeClose = {
      channelId: payload.close.channelId,
      finalBalanceA: BigInt(payload.close.finalBalanceA),
      finalBalanceB: BigInt(payload.close.finalBalanceB),
      signedAt: BigInt(payload.close.signedAt),
    };
    // verify counterparty signature (we accept signature from either party)
    const okA = await verifyCooperativeCloseSignature(
      close,
      payload.sig,
      channel.userA,
      channel.chainId,
      channel.contract,
    );
    const okB = await verifyCooperativeCloseSignature(
      close,
      payload.sig,
      channel.userB,
      channel.chainId,
      channel.contract,
    );
    if (!(okA || okB)) return reject('counter signature did not verify');
    const sig = (await this.account.signTypedData({
      domain: buildDomain(this.deps.chainId, this.deps.verifyingContract),
      types: COOPERATIVE_CLOSE_TYPES,
      primaryType: 'CooperativeClose',
      message: close,
    })) as Hex;
    return {
      id: msg.id,
      kind: 'close.counter',
      payload: {
        sig,
        finalBalanceA: close.finalBalanceA.toString(),
        finalBalanceB: close.finalBalanceB.toString(),
      },
    };
  }
}

void disputesTotal;

function deserializePayState(s: PaySerializedSignedState): SignedState {
  const htlcs: Htlc[] = s.state.htlcs.map((h) => ({
    id: h.id,
    direction: h.direction,
    amount: BigInt(h.amount),
    paymentHash: h.paymentHash,
    expiryMs: BigInt(h.expiryMs),
  }));
  const sigA = hexToSignature(s.sigA);
  const sigB = hexToSignature(s.sigB);
  return {
    state: {
      channelId: s.state.channelId,
      version: BigInt(s.state.version),
      balanceA: BigInt(s.state.balanceA),
      balanceB: BigInt(s.state.balanceB),
      htlcs,
      finalized: s.state.finalized,
    },
    sigA,
    sigB,
  };
}

function hexToSignature(h: Hex): Signature {
  const stripped = h.startsWith('0x') ? h.slice(2) : h;
  if (stripped.length !== 130) {
    throw new Error(`invalid signature hex length ${stripped.length}`);
  }
  return {
    r: `0x${stripped.slice(0, 64)}` as Hex,
    s: `0x${stripped.slice(64, 128)}` as Hex,
    v: Number.parseInt(stripped.slice(128, 130), 16),
  };
}
