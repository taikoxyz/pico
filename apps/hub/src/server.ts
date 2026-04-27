import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerRoutes } from './api/index.js';
import { ChainWatcher } from './chain-watcher.js';
import { ChannelPool } from './channel-pool.js';
import { type HubConfig, loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { logger } from './logger.js';
import { registry } from './metrics.js';

export interface BuildServerResult {
  readonly app: FastifyInstance;
  readonly config: HubConfig;
}

export async function buildServer(
  env: NodeJS.ProcessEnv = process.env,
): Promise<BuildServerResult> {
  const config = loadConfig(env);
  const app = Fastify({ logger: { level: config.logLevel } });

  await app.register(websocket);

  const db = openDatabase(config);
  await db.ready();

  const channelPool = new ChannelPool({ logger });
  const chainWatcher = new ChainWatcher({ rpcUrl: config.rpcUrl, logger });

  await registerRoutes(app, { channelPool });

  app.get('/metrics', async (_req, reply) => {
    void reply.header('Content-Type', registry.contentType);
    return registry.metrics();
  });

  app.addHook('onClose', async () => {
    await chainWatcher.stop();
    await db.close();
  });

  await chainWatcher.start();
  return { app, config };
}

export async function start(): Promise<void> {
  const { app, config } = await buildServer();
  await app.listen({ port: config.port, host: '0.0.0.0' });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  start().catch((err) => {
    logger.error({ err }, 'hub failed to start');
    process.exit(1);
  });
}
