import type { Address, ChainId, ChannelId, CooperativeClose, Hex } from '@tainnel/protocol';
import { COOPERATIVE_CLOSE_TYPES, buildDomain } from '@tainnel/protocol';
import { privateKeyToAccount } from 'viem/accounts';

export interface MockHubHandle {
  readonly url: string;
  stop(): Promise<void>;
}

export interface StartMockHubOptions extends Partial<MockHubOptions> {
  readonly port?: number;
  readonly host?: string;
}

export async function startMockHub(
  opts: StartMockHubOptions = {},
): Promise<MockHubHandle & { hub: MockHub }> {
  const wsModule = (await import('ws')) as unknown as {
    WebSocketServer: new (cfg: { port?: number; host?: string }) => {
      address(): null | string | { address: string; family: string; port: number };
      close(cb?: (err?: Error) => void): void;
      on(event: 'connection', cb: (socket: MockWebSocket) => void): void;
      on(event: 'error', cb: (err: Error) => void): void;
    };
  };
  const server = new wsModule.WebSocketServer({
    port: opts.port ?? 0,
    host: opts.host ?? '127.0.0.1',
  });
  await new Promise<void>((resolve, reject) => {
    server.on('error', (err: Error) => reject(err));
    const start = Date.now();
    const tryAddr = (): void => {
      const a = server.address();
      if (a && typeof a === 'object') {
        resolve();
        return;
      }
      if (Date.now() - start > 1_000) {
        reject(new Error('mock hub failed to bind'));
        return;
      }
      setTimeout(tryAddr, 5);
    };
    tryAddr();
  });
  const addr = server.address();
  if (!addr || typeof addr !== 'object') {
    throw new Error('failed to determine mock hub address');
  }
  const url = `ws://${addr.address}:${addr.port}`;

  const hubOptions: MockHubOptions = {
    hubPrivateKey:
      opts.hubPrivateKey ??
      ('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' as Hex),
    chainId: opts.chainId ?? (167009 as ChainId),
    verifyingContract:
      opts.verifyingContract ?? ('0x1111111111111111111111111111111111111111' as Address),
    ...(opts.preimages ? { preimages: opts.preimages } : {}),
    ...(opts.autoSettlePayments !== undefined
      ? { autoSettlePayments: opts.autoSettlePayments }
      : {}),
    ...(opts.rejectAllPayments !== undefined ? { rejectAllPayments: opts.rejectAllPayments } : {}),
    ...(opts.rejectAllCloses !== undefined ? { rejectAllCloses: opts.rejectAllCloses } : {}),
  };
  const hub = createMockHub(hubOptions);

  server.on('connection', (socket: MockWebSocket) => {
    const handlers = new Set<(msg: { id: string; kind: string; payload: unknown }) => void>();
    const dispose = hub.attach({
      send: async (msg) => {
        socket.send(JSON.stringify(msg));
      },
      onMessage: (h) => {
        handlers.add(h);
        return () => handlers.delete(h);
      },
      close: async () => {
        socket.close();
      },
    });
    socket.on('message', (data: { toString(): string }) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== 'object') return;
      const m = parsed as { id?: unknown; kind?: unknown; payload?: unknown };
      if (typeof m.id !== 'string' || typeof m.kind !== 'string') return;
      const msg = { id: m.id, kind: m.kind, payload: m.payload };
      if (msg.kind === 'ping') {
        socket.send(JSON.stringify({ id: msg.id, kind: 'pong', payload: null }));
        return;
      }
      for (const h of handlers) h(msg);
    });
    socket.on('close', () => dispose());
  });

  const stop = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      server.close((err?: Error) => (err ? reject(err) : resolve()));
    });

  return { url, hub, stop };
}

interface MockWebSocket {
  send(data: string): void;
  close(): void;
  on(event: 'message', cb: (data: { toString(): string }) => void): void;
  on(event: 'close', cb: () => void): void;
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
