import type { Address, ChainId } from '@tainnel/protocol';
import type { FastifyInstance } from 'fastify';
import type { ChannelPool } from '../channel-pool.js';
import type { Logger } from '../logger.js';
import { type WsHandle, registerWsRoutes } from './ws.js';

export interface ApiDeps {
  readonly channelPool: ChannelPool;
  readonly logger: Logger;
  readonly hubPrivateKey: `0x${string}`;
  readonly chainId: ChainId;
  readonly verifyingContract: Address;
  readonly hubFeeBps: bigint;
  readonly hubFeeFlat: bigint;
}

export interface ApiHandle {
  readonly ws: WsHandle;
}

export async function registerRoutes(app: FastifyInstance, deps: ApiDeps): Promise<ApiHandle> {
  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/v1/channels', async () => ({
    channels: deps.channelPool.list(),
  }));

  const ws = await registerWsRoutes(app, {
    channelPool: deps.channelPool,
    logger: deps.logger,
    hubPrivateKey: deps.hubPrivateKey,
    chainId: deps.chainId,
    verifyingContract: deps.verifyingContract,
    hubFeeBps: deps.hubFeeBps,
    hubFeeFlat: deps.hubFeeFlat,
  });

  return { ws };
}
