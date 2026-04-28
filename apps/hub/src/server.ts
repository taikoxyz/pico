import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerRoutes } from './api/index.js';
import { ChainWatcher, chainById } from './chain-watcher.js';
import { ChannelPool } from './channel-pool.js';
import { type HubConfig, loadConfig } from './config.js';
import { type Database, type Repositories, buildRepos, openDatabase } from './db/index.js';
import { DisputeHandler } from './dispute-handler.js';
import { LiquidityTracker } from './liquidity.js';
import { logger } from './logger.js';
import { channelsTotal, inboundLiquidity, outboundLiquidity, registry } from './metrics.js';
import { PreimageRegistry } from './preimage-registry.js';

export interface BuildServerResult {
  readonly app: FastifyInstance;
  readonly config: HubConfig;
  readonly db: Database;
  readonly repos: Repositories;
  readonly channelPool: ChannelPool;
  readonly liquidity: LiquidityTracker;
  readonly preimages: PreimageRegistry;
  readonly chainWatcher?: ChainWatcher;
  readonly disputeHandler?: DisputeHandler;
}

export interface BuildServerOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly disableChainWatcher?: boolean;
}

export async function buildServer(options: BuildServerOptions = {}): Promise<BuildServerResult> {
  const env = options.env ?? process.env;
  const config = loadConfig(env);
  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel },
  });

  await app.register(websocket);

  const db = openDatabase(config);
  await db.ready();
  const repos = buildRepos(db);

  const channelPool = new ChannelPool({
    logger,
    channelRepo: repos.channels,
    stateRepo: repos.states,
  });
  channelPool.hydrate();
  channelsTotal.set(channelPool.size());

  const liquidity = new LiquidityTracker();
  inboundLiquidity.set(Number(liquidity.totalInbound()));
  outboundLiquidity.set(Number(liquidity.totalOutbound()));

  const preimages = new PreimageRegistry();

  let chainWatcher: ChainWatcher | undefined;
  let disputeHandler: DisputeHandler | undefined;
  if (!options.disableChainWatcher) {
    try {
      const chain = chainById(config.chainId);
      chainWatcher = new ChainWatcher({
        rpcUrl: config.rpcUrl,
        chain,
        contractAddress: config.contractAddress,
        logger,
        channelIdFilter: (id) => Boolean(channelPool.get(id)),
      });
      disputeHandler = new DisputeHandler({
        rpcUrl: config.rpcUrl,
        chain,
        contractAddress: config.contractAddress,
        hubPrivateKey: config.hubPrivateKey,
        stateRepo: repos.states,
        disputeRepo: repos.disputes,
        logger,
      });
      chainWatcher.on('channelOpened', (event) => {
        channelPool.setStatus(event.channelId, 'open');
      });
      chainWatcher.on('closingUnilateral', async (event) => {
        if (!disputeHandler) return;
        try {
          await disputeHandler.handle({
            channelId: event.channelId,
            attackerVersion: event.version ?? 0n,
            observedAtMs: event.observedAtMs,
          });
        } catch (err) {
          logger.error({ err, channelId: event.channelId }, 'dispute handler failed');
        }
      });
    } catch (err) {
      logger.warn({ err }, 'chain watcher init skipped');
    }
  }

  const cw = chainWatcher;
  await registerRoutes(app, {
    channelPool,
    repos,
    preimages,
    hubPrivateKey: config.hubPrivateKey,
    chainId: config.chainId,
    verifyingContract: config.contractAddress,
    operatorToken: config.operatorToken,
    logger,
    ...(cw ? { chainProbe: () => cw.pingChain() } : {}),
  });

  app.get('/metrics', async (_req, reply) => {
    void reply.header('Content-Type', registry.contentType);
    return registry.metrics();
  });

  app.addHook('onClose', async () => {
    if (chainWatcher) await chainWatcher.stop();
    await db.close();
  });

  if (chainWatcher) {
    try {
      await chainWatcher.start();
    } catch (err) {
      logger.warn({ err }, 'chain watcher start failed (continuing without it)');
    }
  }

  return {
    app,
    config,
    db,
    repos,
    channelPool,
    liquidity,
    preimages,
    ...(chainWatcher ? { chainWatcher } : {}),
    ...(disputeHandler ? { disputeHandler } : {}),
  };
}

export async function start(): Promise<BuildServerResult> {
  const built = await buildServer();
  await built.app.listen({ port: built.config.port, host: '0.0.0.0' });
  return built;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  start().catch((err) => {
    logger.error({ err }, 'hub failed to start');
    process.exit(1);
  });
}
