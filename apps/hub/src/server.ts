import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { type ApiHandle, registerRoutes } from './api/index.js';
import { ChainWatcher } from './chain-watcher.js';
import { ChannelPool } from './channel-pool.js';
import { type HubConfig, loadConfig } from './config.js';
import { type Database, openDatabase } from './db/index.js';
import { type Repos, buildRepos } from './db/repos/index.js';
import { DisputeHandler } from './dispute-handler.js';
import { LiquidityTracker } from './liquidity.js';
import { logger } from './logger.js';
import { type HubMetrics, buildMetrics, registry } from './metrics.js';

export interface BuildServerResult {
  readonly app: FastifyInstance;
  readonly config: HubConfig;
  readonly channelPool: ChannelPool;
  readonly liquidity: LiquidityTracker;
  readonly repos: Repos;
  readonly db: Database;
  readonly metrics: HubMetrics;
  readonly chainWatcher: ChainWatcher;
  readonly api: ApiHandle;
}

export async function buildServer(
  env: NodeJS.ProcessEnv = process.env,
): Promise<BuildServerResult> {
  const config = loadConfig(env);
  const app = Fastify({ logger: { level: config.logLevel } });

  await app.register(websocket);

  const db = openDatabase(config, { logger });
  await db.ready();
  const repos = buildRepos(db.driver);
  const metrics = buildMetrics(registry);

  const channelPool = new ChannelPool({
    logger,
    channelRepo: repos.channels,
    stateRepo: repos.states,
  });
  await channelPool.hydrate();

  const liquidity = new LiquidityTracker();
  await liquidity.hydrate(repos.htlcs);

  const disputeHandler = new DisputeHandler({
    logger,
    repos,
    channelPool,
    rpcUrl: config.rpcUrl,
    chainId: config.chainId,
    paymentChannelAddress: config.paymentChannelAddress,
    hubPrivateKey: config.hubPrivateKey,
  });

  const chainWatcher = new ChainWatcher({
    rpcUrl: config.rpcUrl,
    logger,
    channelPool,
    repos,
    paymentChannelAddress: config.paymentChannelAddress,
    metrics,
    disputeHandler,
    chainId: config.chainId,
    pollingIntervalMs: config.chainPollingIntervalMs,
    confirmations: config.chainConfirmations,
  });

  const api = await registerRoutes(app, {
    channelPool,
    liquidity,
    repos,
    metrics,
    logger,
    db,
    rpcUrl: config.rpcUrl,
    hubPrivateKey: config.hubPrivateKey,
    chainId: config.chainId,
    verifyingContract: config.adjudicatorAddress,
    hubFeeBps: config.hubFeeBps,
    hubFeeFlat: config.hubFeeFlat,
    requireSignedEnvelope: config.requireSignedEnvelope,
    nonceWindowMs: config.nonceWindowMs,
    operatorToken: config.operatorToken,
  });

  // Metrics serving:
  //  - If PROMETHEUS_PORT is set AND differs from the main port, bind /metrics
  //    on a separate Fastify instance on 127.0.0.1 (private network). This
  //    keeps metrics off the public app surface and matches the documented
  //    operational pattern.
  //  - Otherwise, gate /metrics behind the operator token (if set) or expose
  //    publicly on the main app.
  let metricsApp: FastifyInstance | undefined;
  const refreshAndRender = async (reply: { header(k: string, v: string): unknown }) => {
    void reply.header('Content-Type', registry.contentType);
    metrics.refreshGauges({
      channelsTotal: channelPool.list().length,
      htlcsInFlight: await repos.htlcs.countInflight(),
      inboundLiquidity: liquidity.totalInbound(),
      outboundLiquidity: liquidity.totalOutbound(),
    });
    return registry.metrics();
  };

  if (
    typeof config.prometheusPort === 'number' &&
    config.prometheusPort > 0 &&
    config.prometheusPort !== config.port
  ) {
    metricsApp = Fastify({ logger: { level: config.logLevel } });
    metricsApp.get('/metrics', async (_req, reply) => refreshAndRender(reply));
    await metricsApp.listen({ port: config.prometheusPort, host: '127.0.0.1' });
  } else {
    app.get('/metrics', async (req, reply) => {
      // If an operator token is configured, require it on the main-port path.
      const tok = config.operatorToken;
      if (tok) {
        const auth = req.headers.authorization;
        if (auth !== `Bearer ${tok}`) {
          void reply.code(401);
          return { error: 'unauthorized' };
        }
      }
      return refreshAndRender(reply);
    });
  }

  app.addHook('onClose', async () => {
    await chainWatcher.stop();
    if (metricsApp) await metricsApp.close();
    await db.close();
  });

  await chainWatcher.start();
  return {
    app,
    config,
    channelPool,
    liquidity,
    repos,
    db,
    metrics,
    chainWatcher,
    api,
  };
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
