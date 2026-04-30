import type { Address, ChainId } from '@tainnel/protocol';
import { paymentChannelAbi } from '@tainnel/sdk';
import { http, type PublicClient, createPublicClient, parseAbiItem } from 'viem';
import type { ChannelPool } from './channel-pool.js';
import type { Repos } from './db/repos/index.js';
import type { DisputeHandler } from './dispute-handler.js';
import type { Logger } from './logger.js';
import type { HubMetrics } from './metrics.js';

const KV_KEY_LAST_BLOCK = 'chain_watcher.last_processed_block';

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
}

export class ChainWatcher {
  private readonly client: PublicClient;
  private readonly pollingIntervalMs: number;
  private readonly confirmations: bigint;
  private timer: NodeJS.Timeout | undefined;
  private polling = false;
  private stopped = true;

  constructor(private readonly deps: ChainWatcherDeps) {
    this.client =
      deps.publicClient ??
      (createPublicClient({ transport: http(deps.rpcUrl) }) as unknown as PublicClient);
    this.pollingIntervalMs = deps.pollingIntervalMs ?? 4_000;
    this.confirmations = BigInt(deps.confirmations ?? 3);
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.deps.logger.info(
      {
        rpcUrl: this.deps.rpcUrl,
        contract: this.deps.paymentChannelAddress,
        confirmations: Number(this.confirmations),
      },
      'chain watcher starting',
    );
    if ((await this.deps.repos.kv.get(KV_KEY_LAST_BLOCK)) === undefined) {
      try {
        const head = await this.client.getBlockNumber();
        const initial = head > 0n ? head - 1n : 0n;
        await this.deps.repos.kv.set(KV_KEY_LAST_BLOCK, initial.toString());
      } catch (err) {
        this.deps.logger.warn(
          { err: (err as Error).message },
          'chain watcher could not fetch head; starting at 0',
        );
        await this.deps.repos.kv.set(KV_KEY_LAST_BLOCK, '0');
      }
    }
    this.scheduleNext();
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
      const lastRaw = await this.deps.repos.kv.get(KV_KEY_LAST_BLOCK);
      const last = lastRaw ? BigInt(lastRaw) : 0n;
      if (safeUpto > last) {
        const fromBlock = last + 1n;
        await this.collectAndDispatch(fromBlock, safeUpto);
        await this.deps.repos.kv.set(KV_KEY_LAST_BLOCK, safeUpto.toString());
      }

      try {
        await this.deps.disputeHandler.retryPending();
      } catch (err) {
        this.deps.logger.warn(
          { err: (err as Error).message },
          'dispute retry sweep failed; will try again next poll',
        );
      }
    } catch (err) {
      this.deps.logger.warn(
        { err: (err as Error).message },
        'chain watcher poll failed; will retry',
      );
    } finally {
      this.polling = false;
    }
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
