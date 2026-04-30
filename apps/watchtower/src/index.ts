import type { Address, ChannelId, Hex, SignedState } from '@tainnel/protocol';
import { DEFAULT_DISPUTE_WINDOW_MS } from '@tainnel/protocol';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { type PublicClient, parseAbi } from 'viem';
import { loadConfig } from './config.js';
import { FraudDetector } from './detector.js';
import { buildHttpServer } from './http.js';
import { type Logger, logger as defaultLogger } from './logger.js';
import { rpcUp } from './metrics.js';
import { PenaltyResponder } from './responder.js';
import { type ClosingChannelInfo, Scheduler } from './scheduler.js';
import { SqliteWatchtowerStore, type WatchtowerStore } from './storage.js';
import { ChainEventWatcher, type WatcherEvent } from './watcher.js';

const channelsViewAbi = parseAbi([
  'function channels(bytes32) view returns (address userA, address userB, address token, uint256 amountA, uint256 amountB, uint64 openedAt, uint64 disputeDeadline, uint64 postedVersion, uint256 postedBalanceA, uint256 postedBalanceB, bool penalized, uint8 status, address closer)',
]);

export interface StartWatchtowerOpts {
  readonly rpcUrl: string;
  readonly privateKey: Hex;
  readonly paymentChannelAddress: Address;
  readonly chainId: number;
  readonly dbUrl?: string;
  readonly httpPort?: number;
  readonly logger?: Logger;
  readonly publicClient?: PublicClient;
  readonly pollingIntervalMs?: number;
  readonly confirmations?: number;
  readonly interestedChannelIds?: ReadonlySet<ChannelId>;
  readonly schedulerIntervalMs?: number;
  readonly thresholdRatio?: number;
  readonly windowMs?: number;
  readonly catchupMaxBlocks?: number;
  readonly rpcReconnectMaxBackoffMs?: number;
  readonly startHttp?: boolean;
}

export interface WatchtowerHandle {
  readonly detector: FraudDetector;
  readonly responder: PenaltyResponder;
  readonly watcher: ChainEventWatcher;
  readonly scheduler: Scheduler;
  readonly store: WatchtowerStore;
  readonly http?: FastifyInstance;
  readonly httpUrl?: string;
  remember(state: SignedState): void;
  stop(): Promise<void>;
}

interface ChannelMeta {
  readonly closerSide: 'A' | 'B';
  readonly penalized: boolean;
  readonly disputeDeadlineMs: number;
  readonly postedVersion: bigint;
}

export async function startWatchtower(opts: StartWatchtowerOpts): Promise<WatchtowerHandle> {
  const log = opts.logger ?? defaultLogger;

  const db = new Database(opts.dbUrl ?? ':memory:');
  const store = new SqliteWatchtowerStore(db);
  store.init();

  const detector = new FraudDetector();
  detector.hydrate(store.loadAllSignedStates());

  const responder = new PenaltyResponder({
    rpcUrl: opts.rpcUrl,
    privateKey: opts.privateKey,
    paymentChannelAddress: opts.paymentChannelAddress,
    chainId: opts.chainId,
    logger: log,
    store,
    ...(opts.publicClient ? { publicClient: opts.publicClient } : {}),
  });

  const closingChannels = new Map<ChannelId, ClosingChannelInfo>();

  const watcher = new ChainEventWatcher({
    rpcUrl: opts.rpcUrl,
    paymentChannelAddress: opts.paymentChannelAddress,
    chainId: opts.chainId,
    logger: log,
    ...(opts.publicClient ? { publicClient: opts.publicClient } : {}),
    ...(opts.pollingIntervalMs !== undefined ? { pollingIntervalMs: opts.pollingIntervalMs } : {}),
    ...(opts.confirmations !== undefined ? { confirmations: opts.confirmations } : {}),
    ...(opts.interestedChannelIds !== undefined
      ? { interestedChannelIds: opts.interestedChannelIds }
      : {}),
    ...(opts.rpcReconnectMaxBackoffMs !== undefined
      ? { rpcReconnectMaxBackoffMs: opts.rpcReconnectMaxBackoffMs }
      : {}),
  });

  const sharedClient: PublicClient =
    opts.publicClient ?? (responder as unknown as { publicClient: PublicClient }).publicClient;

  async function readChannelMeta(channelId: ChannelId): Promise<ChannelMeta | null> {
    try {
      const row = (await sharedClient.readContract({
        address: opts.paymentChannelAddress,
        abi: channelsViewAbi,
        functionName: 'channels',
        args: [channelId],
      })) as readonly [
        Address,
        Address,
        Address,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        boolean,
        number,
        Address,
      ];
      const userA = row[0];
      const disputeDeadline = row[6];
      const postedVersion = row[7];
      const penalized = row[10];
      const closer = row[12];
      return {
        closerSide: closer.toLowerCase() === userA.toLowerCase() ? 'A' : 'B',
        penalized,
        disputeDeadlineMs: Number(disputeDeadline) * 1000,
        postedVersion,
      };
    } catch (err) {
      log.error({ err, channelId }, 'failed to read channel meta');
      return null;
    }
  }

  await watcher.start(async (event: WatcherEvent) => {
    if (event.kind === 'closeUnilateral') {
      const channelId = event.channelId as ChannelId;
      const meta = await readChannelMeta(channelId);
      if (!meta) return;
      const postedAtMs = meta.disputeDeadlineMs - DEFAULT_DISPUTE_WINDOW_MS;
      closingChannels.set(channelId, {
        channelId,
        postedVersion: event.version,
        postedAtMs,
        closerSide: meta.closerSide,
        disputeDeadlineMs: meta.disputeDeadlineMs,
        penalized: meta.penalized,
      });

      const evaluation = detector.evaluateClosing({
        channelId,
        postedVersion: event.version,
        postedAtMs,
        windowMs: opts.windowMs ?? DEFAULT_DISPUTE_WINDOW_MS,
        thresholdRatio: opts.thresholdRatio ?? 0.5,
        alreadyPenalized: meta.penalized,
      });
      if (evaluation.action === 'penalize') {
        const existingInFlight = store.getInFlight(channelId);
        const obsId =
          existingInFlight?.observationId ??
          store.recordObservation({
            channelId,
            postedVersion: event.version,
            postedAtMs,
            ourLatestVersion: evaluation.latestKnownVersion,
            actionTaken: 'penalize',
            createdAtMs: Date.now(),
          });
        try {
          await responder.submitPenalty(channelId, evaluation.evidence, meta.closerSide, obsId);
        } catch (err) {
          log.error({ err, channelId }, 'immediate penalty submission failed');
        }
      }
    } else if (event.kind === 'dispute' || event.kind === 'finalize') {
      const channelId = event.channelId as ChannelId;
      if (event.kind === 'finalize') {
        closingChannels.delete(channelId);
        return;
      }
      const meta = await readChannelMeta(channelId);
      if (meta?.penalized) {
        closingChannels.delete(channelId);
        return;
      }
      const existing = closingChannels.get(channelId);
      if (existing && meta) {
        closingChannels.set(channelId, {
          ...existing,
          postedVersion: meta.postedVersion,
          penalized: meta.penalized,
        });
      }
    }
  });

  rpcUp.set(1);

  const scheduler = new Scheduler({
    detector,
    responder,
    store,
    publicClient: sharedClient,
    paymentChannelAddress: opts.paymentChannelAddress,
    logger: log,
    closingProvider: () => closingChannels.values(),
    ...(opts.schedulerIntervalMs !== undefined ? { intervalMs: opts.schedulerIntervalMs } : {}),
    ...(opts.windowMs !== undefined ? { windowMs: opts.windowMs } : {}),
    ...(opts.thresholdRatio !== undefined ? { thresholdRatio: opts.thresholdRatio } : {}),
    ...(opts.catchupMaxBlocks !== undefined ? { catchupMaxBlocks: opts.catchupMaxBlocks } : {}),
  });
  await scheduler.start();

  let http: FastifyInstance | undefined;
  let httpUrl: string | undefined;
  if (opts.startHttp !== false) {
    http = await buildHttpServer({
      logger: log,
      healthProbe: () => ({
        rpc: { up: watcher.isConnected(), lastEventBlockNumber: watcher.lastEventBlockNumber() },
        db: { up: true },
        channelsWatched: closingChannels.size,
      }),
    });
    httpUrl = await http.listen({ port: opts.httpPort ?? 0, host: '127.0.0.1' });
  }

  return {
    detector,
    responder,
    watcher,
    scheduler,
    store,
    ...(http ? { http } : {}),
    ...(httpUrl ? { httpUrl } : {}),
    remember(state: SignedState): void {
      store.putSignedState(state);
      detector.remember(state);
    },
    async stop(): Promise<void> {
      try {
        if (http) await http.close();
      } catch (err) {
        log.error({ err }, 'http close failed');
      }
      scheduler.stop();
      await watcher.stop();
      store.close();
    },
  };
}

export async function start(): Promise<void> {
  const config = loadConfig();
  defaultLogger.info(
    { mode: config.mode, chainId: config.chainId, paymentChannel: config.paymentChannelAddress },
    'watchtower starting',
  );
  await startWatchtower({
    rpcUrl: config.rpcUrl,
    privateKey: config.privateKey as Hex,
    paymentChannelAddress: config.paymentChannelAddress,
    chainId: config.chainId,
    dbUrl: config.dbUrl,
    httpPort: config.port,
    schedulerIntervalMs: config.schedulerIntervalMs,
    confirmations: config.confirmations,
    thresholdRatio: config.penaltyThreshold,
    rpcReconnectMaxBackoffMs: config.rpcReconnectMaxBackoffMs,
    ...(config.interestedChannelIds !== undefined
      ? { interestedChannelIds: new Set(config.interestedChannelIds) }
      : {}),
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  start().catch((err) => {
    defaultLogger.error({ err }, 'watchtower failed to start');
    process.exit(1);
  });
}

export * from './config.js';
export * from './detector.js';
export * from './responder.js';
export * from './scheduler.js';
export * from './storage.js';
export * from './watcher.js';
export * from './http.js';
