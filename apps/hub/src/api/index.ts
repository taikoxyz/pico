import { randomBytes } from 'node:crypto';
import type { Address, ChannelId, Hex } from '@tainnel/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ChannelPool } from '../channel-pool.js';
import type { Repositories } from '../db/index.js';
import type { Logger } from '../logger.js';
import type { PreimageRegistry } from '../preimage-registry.js';
import { HubMessageHandler, type WsMessage } from './ws-handler.js';

export interface ApiDeps {
  readonly channelPool: ChannelPool;
  readonly repos: Repositories;
  readonly preimages: PreimageRegistry;
  readonly hubPrivateKey: Hex;
  readonly chainId: import('@tainnel/protocol').ChainId;
  readonly verifyingContract: Address;
  readonly operatorToken: string;
  readonly logger: Logger;
  readonly chainProbe?: () => Promise<boolean>;
}

interface OpenChannelBody {
  partyA: Address;
  partyB: Address;
  token: Address;
  amountA: string;
  amountB: string;
}

interface RegisterPreimageBody {
  paymentHash: Hex;
  preimage: Hex;
}

export async function registerRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const handler = new HubMessageHandler({
    hubPrivateKey: deps.hubPrivateKey,
    chainId: deps.chainId,
    verifyingContract: deps.verifyingContract,
    channelPool: deps.channelPool,
    repos: deps.repos,
    preimages: deps.preimages,
    logger: deps.logger,
  });

  const requireBearer = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer ') || auth.slice('Bearer '.length) !== deps.operatorToken) {
      void reply.code(401).send({ error: 'unauthorized' });
      return false;
    }
    return true;
  };

  app.get('/health', async () => {
    let dbReady = true;
    try {
      deps.repos.channels.list();
    } catch {
      dbReady = false;
    }
    let chainReady = false;
    if (deps.chainProbe) {
      try {
        chainReady = await Promise.race([
          deps.chainProbe(),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
        ]);
      } catch {
        chainReady = false;
      }
    }
    return { status: dbReady ? 'ok' : 'degraded', dbReady, chainReady };
  });

  app.get('/v1/channels', async (req, reply) => {
    if (!requireBearer(req, reply)) return reply;
    return { channels: deps.channelPool.list() };
  });

  app.post('/v1/channels/open', async (req, reply) => {
    if (!requireBearer(req, reply)) return reply;
    const body = req.body as OpenChannelBody | undefined;
    if (!body?.partyA || !body?.partyB || !body?.token) {
      return reply.code(400).send({ error: 'missing fields' });
    }
    const channelId = `0x${randomHex(64)}` as ChannelId;
    const channel: import('@tainnel/protocol').Channel = {
      id: channelId,
      chainId: deps.chainId,
      contract: deps.verifyingContract,
      userA: body.partyA,
      userB: body.partyB,
      token: body.token,
      status: 'pending',
      openedAt: BigInt(Math.floor(Date.now() / 1000)),
      disputeWindowMs: 24 * 60 * 60 * 1000,
    };
    deps.channelPool.register(channel);
    return { channelId, status: 'pending' };
  });

  app.post('/v1/payments', async (req, reply) => {
    const body = req.body as { msg?: WsMessage } & Record<string, unknown>;
    if (!body || typeof body !== 'object' || !('msg' in body)) {
      return reply.code(400).send({ error: 'expected { msg: { id, kind, payload } }' });
    }
    if (!body.msg) return reply.code(400).send({ error: 'missing msg' });
    const result = await handler.handle(body.msg);
    return reply.send(result ?? { ignored: true });
  });

  app.post('/v1/preimages', async (req, reply) => {
    if (!requireBearer(req, reply)) return reply;
    const body = req.body as RegisterPreimageBody | undefined;
    if (!body?.paymentHash || !body?.preimage) {
      return reply.code(400).send({ error: 'missing fields' });
    }
    deps.preimages.register(body.paymentHash, body.preimage);
    return reply.send({ ok: true });
  });

  app.get('/v1/ws', { websocket: true } as never, (socket: unknown) => {
    const ws = socket as {
      send: (data: string) => void;
      on: (ev: 'message' | 'close', cb: (data?: unknown) => void) => void;
    };
    ws.on('message', (data: unknown) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== 'object') return;
      const m = parsed as { id?: unknown; kind?: unknown; payload?: unknown };
      if (typeof m.id !== 'string' || typeof m.kind !== 'string') return;
      const msg: WsMessage = { id: m.id, kind: m.kind, payload: m.payload };
      handler
        .handle(msg)
        .then((reply) => {
          if (reply) ws.send(JSON.stringify(reply));
        })
        .catch((err) => {
          deps.logger.error({ err, msg }, 'ws handler failed');
        });
    });
  });
}

function randomHex(chars: number): string {
  return randomBytes(Math.ceil(chars / 2))
    .toString('hex')
    .slice(0, chars);
}
