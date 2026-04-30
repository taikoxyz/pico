import Fastify, { type FastifyInstance } from 'fastify';
import type { Logger } from './logger.js';
import { registry } from './metrics.js';

export interface HealthSnapshot {
  readonly rpc: { readonly up: boolean; readonly lastEventBlockNumber: bigint | null };
  readonly db: { readonly up: boolean };
  readonly channelsWatched: number;
}

export interface BuildHttpDeps {
  readonly logger: Logger;
  readonly healthProbe: () => HealthSnapshot;
}

export async function buildHttpServer(deps: BuildHttpDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.get('/health', async (_req, reply) => {
    const snap = deps.healthProbe();
    const ok = snap.rpc.up && snap.db.up;
    void reply.code(ok ? 200 : 503);
    return {
      rpc: {
        up: snap.rpc.up,
        lastEventBlockNumber:
          snap.rpc.lastEventBlockNumber === null ? null : snap.rpc.lastEventBlockNumber.toString(),
      },
      db: { up: snap.db.up },
      channelsWatched: snap.channelsWatched,
    };
  });
  app.get('/metrics', async (_req, reply) => {
    void reply.header('Content-Type', registry.contentType);
    return registry.metrics();
  });
  return app;
}
