import type { Address, ChainId, ChannelId, CooperativeClose, Hex } from '@tainnel/protocol';
import { COOPERATIVE_CLOSE_TYPES, buildDomain } from '@tainnel/protocol';
import { privateKeyToAccount } from 'viem/accounts';

export interface MockHubHandle {
  readonly url: string;
  stop(): Promise<void>;
}

export async function startMockHub(_opts?: { port?: number }): Promise<MockHubHandle> {
  throw new Error(
    'startMockHub: WebSocket-based mock hub not yet implemented; use createMockHub for in-process tests',
  );
}

export interface InMemoryTransportLike {
  send(msg: { id: string; kind: string; payload: unknown }): Promise<void>;
  onMessage(handler: (msg: { id: string; kind: string; payload: unknown }) => void): () => void;
  close(): Promise<void>;
}

export interface MockHubOptions {
  readonly hubPrivateKey: Hex;
  readonly chainId: ChainId;
  readonly verifyingContract: Address;
  readonly preimages?: Map<Hex, Hex>;
  readonly autoSettlePayments?: boolean;
  readonly rejectAllPayments?: boolean;
  readonly rejectAllCloses?: boolean;
}

export interface MockHub {
  readonly seenPayments: Array<{ channelId: ChannelId; paymentHash: Hex; amount: bigint }>;
  readonly seenCloses: Array<{ channelId: ChannelId }>;
  registerPreimage(preimage: Hex, paymentHash: Hex): void;
  attach(transport: InMemoryTransportLike): () => void;
}

export function createMockHub(opts: MockHubOptions): MockHub {
  const account = privateKeyToAccount(opts.hubPrivateKey);
  const preimages = opts.preimages ?? new Map();
  const seenPayments: MockHub['seenPayments'] = [];
  const seenCloses: MockHub['seenCloses'] = [];

  function registerPreimage(preimage: Hex, paymentHash: Hex): void {
    preimages.set(paymentHash.toLowerCase() as Hex, preimage);
  }

  function attach(transport: InMemoryTransportLike): () => void {
    const dispose = transport.onMessage(async (msg) => {
      const reply = await handle(msg);
      if (reply) await transport.send(reply);
    });

    async function handle(msg: {
      id: string;
      kind: string;
      payload: unknown;
    }): Promise<{ id: string; kind: string; payload: unknown } | undefined> {
      if (msg.kind === 'subscribe') {
        return { id: msg.id, kind: 'subscribe.ack', payload: { ok: true } };
      }
      if (msg.kind === 'pay') {
        const payload = (msg.payload ?? {}) as {
          channelId?: ChannelId;
          htlc?: { paymentHash?: Hex; amount?: string };
        };
        if (opts.rejectAllPayments) {
          return { id: msg.id, kind: 'payment.fail', payload: { reason: 'rejected by mock hub' } };
        }
        if (!payload.htlc?.paymentHash) {
          return { id: msg.id, kind: 'payment.fail', payload: { reason: 'missing paymentHash' } };
        }
        const ph = payload.htlc.paymentHash.toLowerCase() as Hex;
        const preimage = preimages.get(ph);
        seenPayments.push({
          channelId: payload.channelId as ChannelId,
          paymentHash: ph,
          amount: BigInt(payload.htlc.amount ?? '0'),
        });
        if (!preimage) {
          if (opts.autoSettlePayments === false) {
            return undefined;
          }
          return {
            id: msg.id,
            kind: 'payment.fail',
            payload: { reason: 'no preimage registered for paymentHash' },
          };
        }
        return { id: msg.id, kind: 'payment.settle', payload: { preimage } };
      }
      if (msg.kind === 'close.request') {
        if (opts.rejectAllCloses) {
          return { id: msg.id, kind: 'close.reject', payload: { reason: 'rejected by mock hub' } };
        }
        const payload = msg.payload as {
          channelId: ChannelId;
          close: {
            channelId: ChannelId;
            finalBalanceA: string;
            finalBalanceB: string;
            signedAt: string;
          };
        };
        seenCloses.push({ channelId: payload.channelId });
        const close: CooperativeClose = {
          channelId: payload.close.channelId,
          finalBalanceA: BigInt(payload.close.finalBalanceA),
          finalBalanceB: BigInt(payload.close.finalBalanceB),
          signedAt: BigInt(payload.close.signedAt),
        };
        const sig = await account.signTypedData({
          domain: buildDomain(opts.chainId, opts.verifyingContract),
          types: COOPERATIVE_CLOSE_TYPES,
          primaryType: 'CooperativeClose',
          message: close,
        });
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
      if (msg.kind === 'ping') {
        return { id: msg.id, kind: 'pong', payload: null };
      }
      return undefined;
    }

    return dispose;
  }

  return { seenPayments, seenCloses, registerPreimage, attach };
}
