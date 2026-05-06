import type { ChannelId } from '@inferenceroom/pico-protocol';
import { DEFAULT_DISPUTE_WINDOW_MS } from '@inferenceroom/pico-protocol';
import { type Address, type PublicClient, parseAbi } from 'viem';
import type { FraudDetector } from './detector.js';
import type { Logger } from './logger.js';
import { channelsWatched, evaluationsTotal } from './metrics.js';
import type { PenaltyResponder } from './responder.js';
import type { WatchtowerStore } from './storage.js';

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_THRESHOLD_RATIO = 0.5;
const DEFAULT_CATCHUP_MAX_BLOCKS = 100_000;
const DEFAULT_CATCHUP_CHUNK_BLOCKS = 10_000n;
const LAST_PROCESSED_BLOCK_KEY = 'last_processed_block_number';

const closingEventAbi = parseAbi([
  'event ChannelClosingUnilateral(bytes32 indexed channelId, uint64 postedVersion, uint256 disputeDeadline)',
]);

const channelsViewAbi = parseAbi([
  'function channels(bytes32) view returns (address userA, address userB, address token, uint256 amountA, uint256 amountB, uint64 openedAt, uint64 disputeDeadline, uint64 postedVersion, uint256 postedBalanceA, uint256 postedBalanceB, bool penalized, uint8 status, address closer)',
]);

export interface ClosingChannelInfo {
  readonly channelId: ChannelId;
  readonly postedVersion: bigint;
  readonly postedAtMs: number;
  readonly closerSide: 'A' | 'B';
  readonly disputeDeadlineMs: number;
  readonly penalized: boolean;
}

export interface SchedulerDeps {
  readonly detector: FraudDetector;
  readonly responder: PenaltyResponder;
  readonly store: WatchtowerStore;
  readonly publicClient: PublicClient;
  readonly paymentChannelAddress: Address;
  readonly logger: Logger;
  readonly intervalMs?: number;
  readonly windowMs?: number;
  readonly thresholdRatio?: number;
  readonly catchupMaxBlocks?: number;
  readonly catchupChunkBlocks?: bigint;
  readonly now?: () => number;
  readonly closingProvider: () => Iterable<ClosingChannelInfo>;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: SchedulerDeps) {}

  async start(): Promise<void> {
    await this.catchup();
    const intervalMs = this.deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        this.deps.logger.error({ err }, 'scheduler tick failed');
      });
    }, intervalMs);
  }

  async tick(): Promise<void> {
    const infos = Array.from(this.deps.closingProvider());
    channelsWatched.set(infos.length);
    for (const info of infos) {
      await this.evaluateAndSubmit(info);
    }
  }

  async catchup(): Promise<void> {
    const head = await this.deps.publicClient.getBlockNumber();
    const lastProcessedRaw = this.deps.store.getMeta(LAST_PROCESSED_BLOCK_KEY);
    const catchupMaxBlocks = BigInt(this.deps.catchupMaxBlocks ?? DEFAULT_CATCHUP_MAX_BLOCKS);
    const chunkSize = this.deps.catchupChunkBlocks ?? DEFAULT_CATCHUP_CHUNK_BLOCKS;
    const earliestAllowed = head > catchupMaxBlocks ? head - catchupMaxBlocks : 0n;
    const desiredFromBlock = lastProcessedRaw ? BigInt(lastProcessedRaw) + 1n : earliestAllowed;
    if (desiredFromBlock < earliestAllowed) {
      this.deps.logger.warn(
        { desiredFromBlock: String(desiredFromBlock), earliestAllowed: String(earliestAllowed) },
        'scheduler: clamping catchup window; events older than catchupMaxBlocks may be missed',
      );
    }
    let chunkStart = desiredFromBlock < earliestAllowed ? earliestAllowed : desiredFromBlock;

    while (chunkStart <= head) {
      const tentativeEnd = chunkStart + chunkSize - 1n;
      const chunkEnd = tentativeEnd > head ? head : tentativeEnd;
      const events = await this.deps.publicClient.getContractEvents({
        address: this.deps.paymentChannelAddress,
        abi: closingEventAbi,
        eventName: 'ChannelClosingUnilateral',
        fromBlock: chunkStart,
        toBlock: chunkEnd,
      });

      for (const log of events) {
        const info = await this.infoFromLog(log);
        if (!info) continue;
        await this.evaluateAndSubmit(info);
      }

      this.deps.store.putMeta(LAST_PROCESSED_BLOCK_KEY, String(chunkEnd));
      chunkStart = chunkEnd + 1n;
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async evaluateAndSubmit(info: ClosingChannelInfo): Promise<void> {
    const windowMs = this.deps.windowMs ?? DEFAULT_DISPUTE_WINDOW_MS;
    const thresholdRatio = this.deps.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO;
    const now = (this.deps.now ?? Date.now)();

    const result = this.deps.detector.evaluateClosing({
      channelId: info.channelId,
      postedVersion: info.postedVersion,
      postedAtMs: info.postedAtMs,
      windowMs,
      thresholdRatio,
      alreadyPenalized: info.penalized,
    });

    evaluationsTotal.inc({ result: result.action });

    if (result.action !== 'penalize') return;
    if (now < result.submitByMs) return;

    const existingInFlight = this.deps.store.getInFlight(info.channelId);
    const observationId =
      existingInFlight?.observationId ??
      this.deps.store.recordObservation({
        channelId: info.channelId,
        postedVersion: info.postedVersion,
        postedAtMs: info.postedAtMs,
        ourLatestVersion: result.latestKnownVersion,
        actionTaken: 'penalize',
        createdAtMs: now,
      });

    try {
      await this.deps.responder.submitPenalty(
        info.channelId,
        result.evidence,
        info.closerSide,
        observationId,
      );
    } catch (err) {
      this.deps.logger.error({ err, channelId: info.channelId }, 'scheduler: submitPenalty failed');
    }
  }

  private async infoFromLog(log: {
    readonly args: {
      readonly channelId?: `0x${string}` | undefined;
      readonly postedVersion?: bigint | undefined;
      readonly disputeDeadline?: bigint | undefined;
    };
    readonly blockNumber: bigint | null;
  }): Promise<ClosingChannelInfo | null> {
    const channelId = log.args.channelId;
    const postedVersion = log.args.postedVersion;
    const disputeDeadline = log.args.disputeDeadline;
    if (
      channelId === undefined ||
      postedVersion === undefined ||
      disputeDeadline === undefined ||
      log.blockNumber === null
    ) {
      return null;
    }

    const block = await this.deps.publicClient.getBlock({ blockNumber: log.blockNumber });
    const postedAtMs = Number(block.timestamp * 1000n);

    const row = await this.deps.publicClient.readContract({
      address: this.deps.paymentChannelAddress,
      abi: channelsViewAbi,
      functionName: 'channels',
      args: [channelId],
    });
    const userA = row[0];
    const penalized = row[10];
    const closer = row[12];
    const closerSide: 'A' | 'B' = closer.toLowerCase() === userA.toLowerCase() ? 'A' : 'B';

    return {
      channelId: channelId as ChannelId,
      postedVersion,
      postedAtMs,
      closerSide,
      disputeDeadlineMs: Number(disputeDeadline * 1000n),
      penalized,
    };
  }
}
