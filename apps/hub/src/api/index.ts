import type { FastifyInstance } from 'fastify';
import type { ChannelPool } from '../channel-pool.js';

export interface ApiDeps {
  readonly channelPool: ChannelPool;
}

export async function registerRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/v1/channels', async () => ({
    channels: deps.channelPool.list(),
  }));

  app.post('/v1/channels/open', async () => {
    throw new Error('not implemented');
  });

  app.post('/v1/payments', async () => {
    throw new Error('not implemented');
  });
}
