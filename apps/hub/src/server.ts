import websocket from '@fastify/websocket';
import { ViemChainAdapter, paymentChannelAbi } from '@inferenceroom/pico-sdk';
import Fastify, { type FastifyInstance } from 'fastify';
import { http, type WalletClient, createPublicClient, createWalletClient, erc20Abi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry, taiko } from 'viem/chains';
import { type ApiHandle, registerRoutes } from './api/index.js';
import { AutoRecycle } from './auto-recycle.js';
import { ChainWatcher } from './chain-watcher.js';
import { ChannelPool } from './channel-pool.js';
import { type HubConfig, loadConfig } from './config.js';
import { type Database, openDatabase } from './db/index.js';
import { type Repos, buildRepos } from './db/repos/index.js';
import { DisputeHandler } from './dispute-handler.js';
import { LiquidityTracker } from './liquidity.js';
import { logger } from './logger.js';
import { type HubMetrics, buildMetrics, registry } from './metrics.js';
import { KeyedMutex } from './mutex.js';
import { TopUpHandler } from './topup-handler.js';
import { DEFAULT_TOPUP_POLICY } from './topup-policy.js';

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
  readonly topupHandler: TopUpHandler;
  readonly autoRecycle: AutoRecycle;
}

function viemChainFor(chainId: number) {
  if (chainId === 167000) return taiko;
  return foundry;
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
  // Round-4 follow-up: liquidity.hydrate restores in-flight HTLC
  // reservations but does NOT restore per-channel outbound/inbound
  // snapshots. Snapshots are normally seeded by `registerChannel` during
  // chain-watcher bootstrap, which only runs for unknown channels; on a
  // restart every channel is already in the pool, so the snapshot stays
  // empty and the router returns `available outbound 0` for everything
  // — blocking pay routing entirely. Seed from the latest co-signed
  // state in `channelPool` so the router immediately reflects post-top-up
  // balances after a hub restart.
  {
    const hubAddrLower = privateKeyToAccount(config.hubPrivateKey).address.toLowerCase();
    for (const channel of channelPool.list()) {
      const latest = channelPool.latest(channel.id);
      if (!latest) continue;
      const hubIsA = channel.userA.toLowerCase() === hubAddrLower;
      liquidity.set(channel.id, {
        outbound: hubIsA ? latest.state.balanceA : latest.state.balanceB,
        inbound: hubIsA ? latest.state.balanceB : latest.state.balanceA,
      });
    }
  }

  const disputeHandler = new DisputeHandler({
    logger,
    repos,
    channelPool,
    rpcUrl: config.rpcUrl,
    chainId: config.chainId,
    paymentChannelAddress: config.paymentChannelAddress,
    hubPrivateKey: config.hubPrivateKey,
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
    paymentChannelAddress: config.paymentChannelAddress,
    verifyingContract: config.adjudicatorAddress,
    hubFeeBps: config.hubFeeBps,
    hubFeeFlat: config.hubFeeFlat,
    requireSignedEnvelope: config.requireSignedEnvelope,
    nonceWindowMs: config.nonceWindowMs,
    paymentRetentionPerChannel: config.paymentRetentionPerChannel,
    operatorToken: config.operatorToken,
  });

  // Build the §8 inbound liquidity stack. It needs the WS push callback and
  // a chain adapter — both available now.
  const hotWalletMutex = new KeyedMutex<string>();
  const chain = viemChainFor(config.chainId);
  const publicClientForChain = createPublicClient({ chain, transport: http(config.rpcUrl) });
  const walletClient: WalletClient = createWalletClient({
    account: privateKeyToAccount(config.hubPrivateKey),
    chain,
    transport: http(config.rpcUrl),
  });
  const chainAdapter = new ViemChainAdapter({
    // ViemChainAdapter casts internally; the public client returned by
    // createPublicClient is shape-compatible with PublicClient<Transport>.
    publicClient: publicClientForChain as never,
    walletClient,
    paymentChannelAddress: config.paymentChannelAddress,
  });

  // Resolve the channel-token by reading the first known channel; in
  // production the hub serves a single ERC-20 (USDC) channel network, so all
  // channels share a token. Defaults to the configured payment channel
  // contract's `token()` if no channel is known yet — but for safety we read
  // from config when available. As a pragmatic default for v1, take it from
  // the first registered channel.
  function resolveToken(): `0x${string}` {
    const first = channelPool.list()[0];
    if (first) return first.token;
    // No channels yet; fall back to the env-configured USDC address if
    // present. This path runs during bootstrap before any open is observed.
    return (env.HUB_USDC_TOKEN ?? '0x0000000000000000000000000000000000000000') as `0x${string}`;
  }

  async function readHotWalletBalance(token: `0x${string}`): Promise<bigint> {
    if (token === '0x0000000000000000000000000000000000000000') {
      return publicClientForChain.getBalance({ address: api.ws.hubAccount.address });
    }
    const balance = (await publicClientForChain.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [api.ws.hubAccount.address],
    })) as bigint;
    return balance;
  }

  const topupHandler = new TopUpHandler({
    channelPool,
    liquidity,
    repos,
    metrics,
    logger,
    hubAccount: api.ws.hubAccount,
    chainId: config.chainId,
    verifyingContract: config.adjudicatorAddress,
    chain: chainAdapter,
    token: resolveToken(),
    policyConfig: DEFAULT_TOPUP_POLICY,
    hotWalletMutex,
    readHotWalletBalance,
    pushProposeTopUp: (toAddress, msg) => api.ws.pushProposeTopUp(toAddress, msg),
    pushTopUpComplete: (toAddress, msg) => api.ws.pushTopUpComplete(toAddress, msg),
  });
  await topupHandler.hydrate();
  api.ws.attachTopUpHandler(topupHandler);

  const autoRecycle = new AutoRecycle({
    logger,
    repos,
    channelPool,
    topupHandler,
    hotWalletMutex,
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
    topupHandler,
    autoRecycle,
    hubAddress: api.ws.hubAccount.address,
  });

  // Metrics serving:
  //  - If PROMETHEUS_PORT is set AND differs from the main port, bind /metrics
  //    on a separate Fastify instance. METRICS_BIND_ADDR controls whether the
  //    listener stays loopback-only or is reachable by in-cluster scrapers.
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
    await metricsApp.listen({ port: config.prometheusPort, host: config.metricsBindAddr });
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
  // paymentChannelAbi is exported above to keep tree-shaking honest; reference
  // it once so unused-import linters don't strip it.
  void paymentChannelAbi;
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
    topupHandler,
    autoRecycle,
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
