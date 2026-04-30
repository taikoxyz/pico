import type { Address, ChannelId, Hex, SignedState } from '@tainnel/protocol';
import { type PublicClient, parseAbi } from 'viem';
import { loadConfig } from './config.js';
import { FraudDetector } from './detector.js';
import { logger as defaultLogger } from './logger.js';
import { PenaltyResponder } from './responder.js';
import { MemoryBackupStore } from './storage.js';
import { ChainEventWatcher, type WatcherEvent } from './watcher.js';

const channelsViewAbi = parseAbi([
  'function channels(bytes32) view returns (address userA, address userB, address token, uint256 amountA, uint256 amountB, uint64 openedAt, uint64 disputeDeadline, uint64 postedVersion, uint256 postedBalanceA, uint256 postedBalanceB, bool penalized, uint8 status, address closer)',
]);

export interface StartWatchtowerOpts {
  readonly rpcUrl: string;
  readonly privateKey: Hex;
  readonly paymentChannelAddress: Address;
  readonly chainId: number;
  readonly logger?: typeof defaultLogger;
  readonly publicClient?: PublicClient;
  readonly pollingIntervalMs?: number;
}

export interface WatchtowerHandle {
  readonly detector: FraudDetector;
  readonly responder: PenaltyResponder;
  remember(state: SignedState): void;
  stop(): Promise<void>;
}

export async function startWatchtower(opts: StartWatchtowerOpts): Promise<WatchtowerHandle> {
  const log = opts.logger ?? defaultLogger;
  const detector = new FraudDetector();
  const responder = new PenaltyResponder({
    rpcUrl: opts.rpcUrl,
    privateKey: opts.privateKey,
    paymentChannelAddress: opts.paymentChannelAddress,
    chainId: opts.chainId,
    logger: log,
    ...(opts.publicClient ? { publicClient: opts.publicClient } : {}),
  });
  const watcher = new ChainEventWatcher({
    rpcUrl: opts.rpcUrl,
    paymentChannelAddress: opts.paymentChannelAddress,
    chainId: opts.chainId,
    logger: log,
    ...(opts.publicClient ? { publicClient: opts.publicClient } : {}),
    ...(opts.pollingIntervalMs !== undefined ? { pollingIntervalMs: opts.pollingIntervalMs } : {}),
  });

  await watcher.start(async (event: WatcherEvent) => {
    if (event.kind !== 'closeUnilateral') return;
    const detection = detector.evaluate(event.channelId, event.version);
    if (!detection.fraudulent) {
      log.debug({ event, detection }, 'observed unilateral close; not stale');
      return;
    }
    const evidence = detector.getLatest(event.channelId);
    if (!evidence) {
      log.warn({ event, detection }, 'fraud detected but no evidence state stored');
      return;
    }
    const closerSide = await readCloserSide(
      responder,
      event.channelId,
      opts.paymentChannelAddress,
      opts.publicClient,
    );
    log.warn(
      {
        channelId: event.channelId,
        postedVersion: event.version,
        ourVersion: evidence.state.version,
        closerSide,
      },
      'fraud detected; submitting dispute',
    );
    await responder.submitPenalty(event.channelId, evidence, closerSide);
  });

  return {
    detector,
    responder,
    remember(state: SignedState): void {
      detector.remember(state);
    },
    async stop(): Promise<void> {
      await watcher.stop();
    },
  };
}

async function readCloserSide(
  responder: PenaltyResponder,
  channelId: ChannelId,
  paymentChannel: Address,
  publicClient?: PublicClient,
): Promise<'A' | 'B'> {
  const client =
    publicClient ?? (responder as unknown as { publicClient: PublicClient }).publicClient;
  const row = await client.readContract({
    address: paymentChannel,
    abi: channelsViewAbi,
    functionName: 'channels',
    args: [channelId],
  });
  const userA = row[0];
  const closer = row[12];
  return closer.toLowerCase() === userA.toLowerCase() ? 'A' : 'B';
}

export async function start(): Promise<void> {
  const config = loadConfig();
  defaultLogger.info({ mode: config.mode }, 'watchtower starting');
  await startWatchtower({
    rpcUrl: config.rpcUrl,
    privateKey: config.privateKey as Hex,
    paymentChannelAddress: '0x0000000000000000000000000000000000000000' as Address,
    chainId: 167000,
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
export * from './storage.js';
export * from './watcher.js';

void MemoryBackupStore;
