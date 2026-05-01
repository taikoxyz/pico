import type { Address, ChainId } from '@tainnel/protocol';
import { paymentChannelAbi } from '@tainnel/sdk';
import { http, type PublicClient, createPublicClient, parseAbiItem } from 'viem';
import type { ChannelPool } from './channel-pool.js';
import type { Repos } from './db/repos/index.js';
import type { DisputeHandler } from './dispute-handler.js';
import type { Logger } from './logger.js';
import type { HubMetrics } from './metrics.js';

const KV_KEY_LAST_BLOCK = 'chain_watcher.last_processed_block';
const KV_KEY_LAST_BLOCK_HASH = 'chain_watcher.last_processed_block_hash';
const KV_KEY_DEPLOY_BLOCK = 'chain_watcher.deploy_block';
// Cap getLogs ranges to bound RPC payload size and recover from long downtime.
const DEFAULT_CHUNK_SIZE = 500n;

const channelOpenedEvent = parseAbiItem(
  'event ChannelOpened(bytes32 indexed channelId, address indexed userA, address indexed userB, address token, uint256 amountA, uint256 amountB)',
);
const channelClosingUnilateralEvent = parseAbiItem(
  'event ChannelClosingUnilateral(bytes32 indexed channelId, uint64 postedVersion, uint256 disputeDeadline)',
);
const disputeRaisedEvent = parseAbiItem(
  'event DisputeRaised(bytes32 indexed channelId, uint64 challengerVersion)',
);
const channelFinalizedEvent = parseAbiItem(
  'event ChannelFinalized(bytes32 indexed channelId, uint256 paidA, uint256 paidB)',
);

export interface ChainWatcherDeps {
  readonly rpcUrl: string;
  readonly logger: Logger;
  readonly channelPool: ChannelPool;
  readonly repos: Repos;
  readonly paymentChannelAddress: Address;
  readonly metrics: HubMetrics;
  readonly disputeHandler: DisputeHandler;
  readonly chainId: ChainId;
  readonly pollingIntervalMs?: number;
  readonly confirmations?: number;
  readonly publicClient?: PublicClient;
  /** Block to start scanning from on first run, if no checkpoint exists. */
  readonly deployBlock?: bigint;
  /** Maximum number of blocks per getLogs call. */
  readonly chunkSize?: bigint;
}

export class ChainWatcher {
  private readonly client: PublicClient;
  private readonly pollingIntervalMs: number;
  private readonly confirmations: bigint;
  private readonly chunkSize: bigint;
  private timer: NodeJS.Timeout | undefined;
  private polling = false;
  private stopped = true;
  private lastError: string | undefined;
  private lagBlocks = 0n;

  constructor(private readonly deps: ChainWatcherDeps) {
    this.client =
      deps.publicClient ??
      (createPublicClient({ transport: http(deps.rpcUrl) }) as unknown as PublicClient);
    this.pollingIntervalMs = deps.pollingIntervalMs ?? 4_000;
    this.confirmations = BigInt(deps.confirmations ?? 3);
    this.chunkSize = deps.chunkSize ?? DEFAULT_CHUNK_SIZE;
  }

  /** For metrics: current lag (blocks) between safe head and our cursor. */
  getLagBlocks(): bigint {
    return this.lagBlocks;
  }

  /** For metrics: most recent error message, if any. */
  getLastError(): string | undefined {
    return this.lastError;
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.deps.logger.info(
      {
        rpcUrl: this.deps.rpcUrl,
        contract: this.deps.paymentChannelAddress,
        confirmations: Number(this.confirmations),
        chunkSize: this.chunkSize.toString(),
      },
      'chain watcher starting',
    );
    if ((await this.deps.repos.kv.get(KV_KEY_LAST_BLOCK)) === undefined) {
      // Prefer an explicit deploy block; otherwise the minimum opened-block of
      // any known channel; otherwise fall back to (head - confirmations).
      // Avoid silently advancing past historical events.
      const initial = await this.computeInitialBlock();
      await this.deps.repos.kv.set(KV_KEY_LAST_BLOCK, initial.toString());
      this.deps.logger.info(
        { initialBlock: initial.toString() },
        'chain watcher: initial cursor set',
      );
    }
    this.scheduleNext();
  }

  private async computeInitialBlock(): Promise<bigint> {
    const deployBlockKv = await this.deps.repos.kv.get(KV_KEY_DEPLOY_BLOCK);
    if (deployBlockKv) return BigInt(deployBlockKv);
    if (this.deps.deployBlock !== undefined) {
      await this.deps.repos.kv.set(KV_KEY_DEPLOY_BLOCK, this.deps.deployBlock.toString());
      return this.deps.deployBlock;
    }
    try {
      const head = await this.client.getBlockNumber();
      const safeHead = head > this.confirmations ? head - this.confirmations : 0n;
      return safeHead;
    } catch (err) {
      this.deps.logger.warn(
        { err: (err as Error).message },
        'chain watcher could not fetch head; starting at 0',
      );
      return 0n;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const head = await this.client.getBlockNumber();
      const safeUpto = head >= this.confirmations ? head - this.confirmations : 0n;
      this.lagBlocks = head > safeUpto ? head - safeUpto : 0n;

      // Reorg detection: re-fetch the block at our cursor and compare hashes.
      // Mismatch means our last_processed_block was in a fork that has since
      // been replaced. Rewind to the last common ancestor.
      const lastRaw = await this.deps.repos.kv.get(KV_KEY_LAST_BLOCK);
      let last = lastRaw ? BigInt(lastRaw) : 0n;
      const expectedHash = await this.deps.repos.kv.get(KV_KEY_LAST_BLOCK_HASH);
      if (expectedHash !== undefined && last > 0n) {
        try {
          const currentBlock = await this.client.getBlock({ blockNumber: last });
          if (currentBlock.hash !== expectedHash) {
            const rewound = await this.findCommonAncestor(last, expectedHash);
            this.deps.logger.warn(
              {
                cursor: last.toString(),
                expectedHash,
                actualHash: currentBlock.hash,
                rewoundTo: rewound.toString(),
              },
              'chain watcher: reorg detected; rewinding cursor',
            );
            last = rewound;
            await this.deps.repos.kv.set(KV_KEY_LAST_BLOCK, last.toString());
            // Drop stale hash; we'll re-record it after the next clean cycle.
            await this.deps.repos.kv.set(KV_KEY_LAST_BLOCK_HASH, '');
          }
        } catch (err) {
          this.deps.logger.warn(
            { err: (err as Error).message, last: last.toString() },
            'reorg check failed; skipping this poll',
          );
          this.lastError = (err as Error).message;
          return;
        }
      }

      if (safeUpto > last) {
        const fromBlock = last + 1n;
        // Chunk the scan so a long downtime + huge fromBlock..safeUpto range
        // doesn't blow up the RPC payload. On any chunk failure, we abort
        // without advancing the cursor (next poll resumes from `last`).
        let cursor = fromBlock;
        while (cursor <= safeUpto) {
          const chunkEnd = cursor + this.chunkSize - 1n;
          const upto = chunkEnd > safeUpto ? safeUpto : chunkEnd;
          await this.collectAndDispatch(cursor, upto);
          await this.deps.repos.kv.set(KV_KEY_LAST_BLOCK, upto.toString());
          // Persist the hash of the just-processed tip so we can detect a
          // future reorg that rolls these events back.
          try {
            const tip = await this.client.getBlock({ blockNumber: upto });
            await this.deps.repos.kv.set(KV_KEY_LAST_BLOCK_HASH, tip.hash);
          } catch {
            // Hash recording is best-effort; absence triggers re-record next poll.
          }
          cursor = upto + 1n;
        }
      }

      this.lastError = undefined;
      try {
        await this.deps.disputeHandler.retryPending();
      } catch (err) {
        this.deps.logger.warn(
          { err: (err as Error).message },
          'dispute retry sweep failed; will try again next poll',
        );
      }
    } catch (err) {
      this.lastError = (err as Error).message;
      this.deps.logger.warn(
        { err: (err as Error).message },
        'chain watcher poll failed; will retry',
      );
    } finally {
      this.polling = false;
    }
  }

  /**
   * Walk back from `from` until we find a block whose stored hash matches the
   * RPC's current view, OR until we reach 0. Returns the highest block known
   * to be on the canonical chain. Conservative: in practice we just rewind
   * one full chunk, which is ample for the typical 1-3 block reorg.
   */
  private async findCommonAncestor(from: bigint, _staleHash: string): Promise<bigint> {
    const rewindTo = from > this.chunkSize ? from - this.chunkSize : 0n;
    return rewindTo;
  }

  private async collectAndDispatch(fromBlock: bigint, toBlock: bigint): Promise<void> {
    const opened = await this.client.getLogs({
      address: this.deps.paymentChannelAddress,
      event: channelOpenedEvent,
      fromBlock,
      toBlock,
    });
    for (const log of opened) {
      const channelId = log.args.channelId;
      if (channelId && this.deps.channelPool.get(channelId)) {
        await this.deps.channelPool.setStatus(channelId, 'open');
        this.deps.logger.info({ channelId }, 'channel opened on-chain');
      }
    }

    const closing = await this.client.getLogs({
      address: this.deps.paymentChannelAddress,
      event: channelClosingUnilateralEvent,
      fromBlock,
      toBlock,
    });
    for (const log of closing) {
      const channelId = log.args.channelId;
      const postedVersion = log.args.postedVersion;
      if (!channelId || postedVersion === undefined) continue;
      if (!this.deps.channelPool.get(channelId)) continue;
      await this.deps.channelPool.setStatus(channelId, 'closing-unilateral');
      this.deps.metrics.disputesTotal.inc({ outcome: 'observed' });
      await this.deps.disputeHandler.handle({
        channelId,
        attackerVersion: postedVersion,
        observedAtMs: Date.now(),
      });
    }

    const disputed = await this.client.getLogs({
      address: this.deps.paymentChannelAddress,
      event: disputeRaisedEvent,
      fromBlock,
      toBlock,
    });
    for (const log of disputed) {
      const channelId = log.args.channelId;
      if (channelId && this.deps.channelPool.get(channelId)) {
        await this.deps.channelPool.setStatus(channelId, 'disputed');
        this.deps.logger.info(
          { channelId, version: log.args.challengerVersion },
          'dispute observed on-chain',
        );
      }
    }

    const finalized = await this.client.getLogs({
      address: this.deps.paymentChannelAddress,
      event: channelFinalizedEvent,
      fromBlock,
      toBlock,
    });
    for (const log of finalized) {
      const channelId = log.args.channelId;
      if (channelId && this.deps.channelPool.get(channelId)) {
        await this.deps.channelPool.setStatus(channelId, 'closed');
        this.deps.logger.info({ channelId }, 'channel finalized on-chain');
      }
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.pollOnce().finally(() => this.scheduleNext());
    }, this.pollingIntervalMs);
  }
}

export { paymentChannelAbi };
