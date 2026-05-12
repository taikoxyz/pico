import type {
  Address,
  ChainId,
  ChannelId,
  Hex,
  Signature,
  SignedState,
} from '@inferenceroom/pico-protocol';
import { DEFAULT_DISPUTE_WINDOW_MS } from '@inferenceroom/pico-protocol';
import { verifyChannelStateSignature } from '@inferenceroom/pico-state-machine';
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

const adjudicatorViewAbi = parseAbi(['function adjudicator() view returns (address)']);

export interface StartWatchtowerOpts {
  readonly rpcUrl: string;
  readonly privateKey: Hex;
  readonly paymentChannelAddress: Address;
  readonly adjudicatorAddress?: Address;
  readonly chainId: number;
  readonly dbUrl?: string;
  readonly httpPort?: number;
  readonly httpHost?: string;
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
  remember(state: SignedState): Promise<void>;
  stop(): Promise<void>;
}

interface ChannelMeta {
  readonly closerSide: 'A' | 'B';
  readonly penalized: boolean;
  readonly disputeDeadlineMs: number;
  readonly postedVersion: bigint;
}

interface ChannelInvariants {
  readonly userA: Address;
  readonly userB: Address;
  readonly totalFunding: bigint;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

function sigToHex(sig: Signature): Hex {
  const v = sig.v.toString(16).padStart(2, '0');
  return `0x${sig.r.slice(2)}${sig.s.slice(2)}${v}` as Hex;
}

const ZERO_HEX_32 = `0x${'0'.repeat(64)}` as Hex;
function isZeroSignature(sig: Signature): boolean {
  return sig.r === ZERO_HEX_32 && sig.s === ZERO_HEX_32;
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

  const channelInvariantsCache = new Map<ChannelId, ChannelInvariants>();

  let adjudicatorAddressPromise: Promise<Address> | undefined;
  async function getAdjudicatorAddress(): Promise<Address> {
    if (opts.adjudicatorAddress) return opts.adjudicatorAddress;
    if (!adjudicatorAddressPromise) {
      adjudicatorAddressPromise = sharedClient
        .readContract({
          address: opts.paymentChannelAddress,
          abi: adjudicatorViewAbi,
          functionName: 'adjudicator',
        })
        .then((a) => a as Address);
    }
    return adjudicatorAddressPromise;
  }

  type ChannelRow = readonly [
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

  async function readChannelRow(channelId: ChannelId): Promise<ChannelRow> {
    const row = (await sharedClient.readContract({
      address: opts.paymentChannelAddress,
      abi: channelsViewAbi,
      functionName: 'channels',
      args: [channelId],
    })) as ChannelRow;
    const userA = row[0];
    if (userA !== ZERO_ADDRESS) {
      channelInvariantsCache.set(channelId, {
        userA,
        userB: row[1],
        totalFunding: row[3] + row[4],
      });
    }
    return row;
  }

  async function readChannelMeta(channelId: ChannelId): Promise<ChannelMeta | null> {
    try {
      const row = await readChannelRow(channelId);
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

  async function getChannelInvariants(channelId: ChannelId): Promise<ChannelInvariants> {
    const cached = channelInvariantsCache.get(channelId);
    if (cached) return cached;
    await readChannelRow(channelId);
    const fresh = channelInvariantsCache.get(channelId);
    if (!fresh) {
      throw new Error(`watchtower.remember: unknown channel ${channelId}`);
    }
    return fresh;
  }

  async function validateSignedState(state: SignedState): Promise<void> {
    const inv = await getChannelInvariants(state.state.channelId);
    // v2: in-flight HTLCs are accepted. Conservation is now
    // balanceA + balanceB + htlcsTotalLocked == totalFunding.
    if (state.state.balanceA + state.state.balanceB + state.state.htlcsTotalLocked !== inv.totalFunding) {
      throw new Error(
        `watchtower.remember: balance not conserved for channel ${state.state.channelId} (got ${state.state.balanceA + state.state.balanceB + state.state.htlcsTotalLocked}, expected ${inv.totalFunding})`,
      );
    }
    if (state.state.finalized) {
      throw new Error(
        `watchtower.remember: state is finalized; not penalty-capable (channel ${state.state.channelId})`,
      );
    }
    const verifyingContract = await getAdjudicatorAddress();
    let okA = false;
    try {
      okA = await verifyChannelStateSignature(
        state.state,
        sigToHex(state.sigA),
        inv.userA,
        opts.chainId as ChainId,
        verifyingContract,
      );
    } catch {
      okA = false;
    }
    if (!okA) {
      throw new Error(
        `watchtower.remember: sigA does not verify against userA for channel ${state.state.channelId}`,
      );
    }
    let okB = false;
    try {
      okB = await verifyChannelStateSignature(
        state.state,
        sigToHex(state.sigB),
        inv.userB,
        opts.chainId as ChainId,
        verifyingContract,
      );
    } catch {
      okB = false;
    }
    if (!okB) {
      throw new Error(
        `watchtower.remember: sigB does not verify against userB for channel ${state.state.channelId}`,
      );
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
        if (Date.now() < evaluation.submitByMs) return;
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
      healthProbe: () => {
        let dbUp = false;
        let dbErr: string | undefined;
        try {
          dbUp = store.ping();
        } catch (err) {
          dbErr = (err as Error).message;
        }
        return {
          rpc: { up: watcher.isConnected(), lastEventBlockNumber: watcher.lastEventBlockNumber() },
          db: { up: dbUp, ...(dbErr !== undefined ? { error: dbErr } : {}) },
          channelsWatched: closingChannels.size,
        };
      },
    });
    httpUrl = await http.listen({ port: opts.httpPort ?? 0, host: opts.httpHost ?? '127.0.0.1' });
  }

  return {
    detector,
    responder,
    watcher,
    scheduler,
    store,
    ...(http ? { http } : {}),
    ...(httpUrl ? { httpUrl } : {}),
    async remember(state: SignedState): Promise<void> {
      if (isZeroSignature(state.sigA) || isZeroSignature(state.sigB)) {
        return;
      }
      await validateSignedState(state);
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
    httpHost: config.metricsBindAddr,
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
