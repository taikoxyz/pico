import { type WatchtowerConfig, loadConfig } from './config.js';
import { FraudDetector } from './detector.js';
import { WatchtowerHttpServer } from './http.js';
import { type Logger, logger } from './logger.js';
import { WatchtowerMetrics } from './metrics.js';
import { PenaltyResponder } from './responder.js';
import { PenaltyScheduler } from './scheduler.js';
import { ObservationRepo, type SqliteHandle, SqliteStateStore, openSqlite } from './storage.js';
import { ChainEventWatcher, type WatcherEvent, chainById } from './watcher.js';

export interface WatchtowerHandle {
  readonly config: WatchtowerConfig;
  readonly httpPort: number;
  stop(): Promise<void>;
}

export interface AssembleOverrides {
  readonly sqliteHandle?: SqliteHandle;
  readonly watcher?: ChainEventWatcher;
  readonly responder?: PenaltyResponder;
  readonly httpServer?: WatchtowerHttpServer;
  readonly schedulerIntervalMs?: number;
  readonly logger?: Logger;
}

export async function assemble(
  config: WatchtowerConfig,
  overrides: AssembleOverrides = {},
): Promise<WatchtowerHandle> {
  const log = overrides.logger ?? logger;
  const sqliteHandle = overrides.sqliteHandle ?? openSqlite(config.dbUrl);
  const stateStore = new SqliteStateStore(sqliteHandle.raw);
  const observationRepo = new ObservationRepo(sqliteHandle.raw);
  const detector = new FraudDetector({ stateStore });
  await detector.hydrate();
  const metrics = new WatchtowerMetrics();
  metrics.set('channelsWatched', detector.channelsWatched());

  const chain = chainById(config.chainId);
  const responder =
    overrides.responder ??
    new PenaltyResponder({
      rpcUrl: config.rpcUrl,
      chain,
      contractAddress: config.contractAddress,
      privateKey: config.privateKey,
      logger: log,
    });

  const watcher =
    overrides.watcher ??
    new ChainEventWatcher({
      rpcUrl: config.rpcUrl,
      chain,
      contractAddress: config.contractAddress,
      logger: log,
    });

  const handler = async (event: WatcherEvent): Promise<void> => {
    metrics.inc('evaluationsTotal');
    if (event.kind !== 'closeUnilateral') return;
    const r = detector.evaluateClosing(event.channelId, event.version, event.observedAtMs, {
      windowMs: config.windowMs,
      threshold: config.threshold,
    });
    if (r.action === 'noop') {
      log.info({ channelId: event.channelId, reason: r.reason }, 'closing event ignored');
      return;
    }
    observationRepo.record({
      channelId: event.channelId,
      postedVersion: event.version,
      postedAt: event.observedAtMs,
      ourLatestVersion: r.evidence.state.version,
      actionTaken: 'penalize',
      submitBy: r.submitBy,
      lastBlock: Number(event.blockNumber),
    });
    log.warn(
      {
        channelId: event.channelId,
        postedVersion: event.version.toString(),
        ourVersion: r.evidence.state.version.toString(),
        submitBy: r.submitBy,
      },
      'penalty observation recorded',
    );
  };

  await watcher.start(handler);

  const scheduler = new PenaltyScheduler({
    observationRepo,
    detector,
    responder,
    metrics,
    logger: log,
    intervalMs: overrides.schedulerIntervalMs ?? config.schedulerIntervalMs,
  });
  await scheduler.start();

  const httpServer =
    overrides.httpServer ??
    new WatchtowerHttpServer({
      port: config.port,
      logger: log,
      metrics,
      probe: () => ({
        rpcUp: watcher.isRpcUp(),
        dbReady: true,
        lastEventBlock: Number(watcher.getLastBlock()),
        channelsWatched: detector.channelsWatched(),
      }),
    });
  const { port } = await httpServer.start();

  return {
    config,
    httpPort: port,
    stop: async () => {
      scheduler.stop();
      await watcher.stop();
      await httpServer.stop();
      sqliteHandle.close();
    },
  };
}

export async function start(): Promise<void> {
  const config = loadConfig();
  const handle = await assemble(config);
  logger.info(
    { mode: handle.config.mode, port: handle.httpPort, chainId: handle.config.chainId },
    'watchtower running',
  );
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    await handle.stop();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  start().catch((err) => {
    logger.error({ err }, 'watchtower failed to start');
    process.exit(1);
  });
}

export * from './config.js';
export * from './detector.js';
export * from './http.js';
export * from './metrics.js';
export * from './responder.js';
export * from './scheduler.js';
export * from './storage.js';
export * from './watcher.js';
