import type { Address } from '@tainnel/protocol';
import {
  http,
  type Chain,
  type Hash,
  type PublicClient,
  TransactionReceiptNotFoundError,
  createPublicClient,
  parseAbi,
} from 'viem';
import { foundry, taiko } from 'viem/chains';
import type { Logger } from './logger.js';
import * as metrics from './metrics.js';

const eventsAbi = parseAbi([
  'event ChannelOpened(bytes32 indexed channelId, address userA, address userB, address token, uint256 amountA, uint256 amountB)',
  'event ChannelClosingUnilateral(bytes32 indexed channelId, uint64 postedVersion, uint256 disputeDeadline)',
  'event DisputeRaised(bytes32 indexed channelId, uint64 version)',
  'event ChannelFinalized(bytes32 indexed channelId, uint256 payA, uint256 payB)',
]);

type EventName =
  | 'ChannelOpened'
  | 'ChannelClosingUnilateral'
  | 'DisputeRaised'
  | 'ChannelFinalized';

const ALL_EVENT_NAMES: readonly EventName[] = [
  'ChannelOpened',
  'ChannelClosingUnilateral',
  'DisputeRaised',
  'ChannelFinalized',
];

const DEFAULT_CONFIRMATIONS = 3;
const DEFAULT_RECONNECT_MAX_BACKOFF_MS = 30_000;
const RECONNECT_BASE_DELAY_MS = 250;
const RPC_DOWN_REPORT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_POLLING_INTERVAL_MS = 250;

function chainForId(chainId: number): Chain {
  if (chainId === 167000) return taiko;
  return foundry;
}

function isReceiptNotFound(err: unknown): boolean {
  if (err instanceof TransactionReceiptNotFoundError) return true;
  return (err as { name?: string } | null)?.name === 'TransactionReceiptNotFoundError';
}

export type WatcherEventKind = 'open' | 'closeUnilateral' | 'dispute' | 'finalize';

export type WatcherEvent =
  | {
      readonly kind: 'open';
      readonly channelId: `0x${string}`;
      readonly txHash: `0x${string}`;
      readonly blockNumber: bigint;
    }
  | {
      readonly kind: 'closeUnilateral';
      readonly channelId: `0x${string}`;
      readonly version: bigint;
      readonly disputeDeadline: bigint;
      readonly txHash: `0x${string}`;
      readonly blockNumber: bigint;
    }
  | {
      readonly kind: 'dispute';
      readonly channelId: `0x${string}`;
      readonly version: bigint;
      readonly txHash: `0x${string}`;
      readonly blockNumber: bigint;
    }
  | {
      readonly kind: 'finalize';
      readonly channelId: `0x${string}`;
      readonly payA: bigint;
      readonly payB: bigint;
      readonly txHash: `0x${string}`;
      readonly blockNumber: bigint;
    };

export type WatcherHandler = (event: WatcherEvent) => Promise<void>;

export interface ChainEventWatcherDeps {
  readonly rpcUrl: string;
  readonly paymentChannelAddress: Address;
  readonly chainId: number;
  readonly logger: Logger;
  readonly publicClient?: PublicClient;
  readonly pollingIntervalMs?: number;
  readonly confirmations?: number;
  readonly interestedChannelIds?: ReadonlySet<`0x${string}`>;
  readonly rpcReconnectMaxBackoffMs?: number;
}

interface PendingEntry {
  readonly event: WatcherEvent;
  readonly blockNumber: bigint;
}

export class ChainEventWatcher {
  private readonly publicClient: PublicClient;
  private readonly confirmations: number;
  private readonly maxBackoffMs: number;
  private readonly pollingIntervalMs: number;
  private readonly pending = new Map<Hash, PendingEntry>();
  private unwatches: Array<() => void> = [];
  private handler: WatcherHandler | undefined;
  private connected = false;
  private headBlock: bigint | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private rpcDownInterval: ReturnType<typeof setInterval> | undefined;
  private reconnectAttempts = 0;
  private stopped = false;

  constructor(private readonly deps: ChainEventWatcherDeps) {
    const chain = chainForId(deps.chainId);
    this.publicClient =
      deps.publicClient ??
      (createPublicClient({
        chain,
        transport: http(deps.rpcUrl),
      }) as PublicClient);
    this.confirmations = deps.confirmations ?? DEFAULT_CONFIRMATIONS;
    this.maxBackoffMs = deps.rpcReconnectMaxBackoffMs ?? DEFAULT_RECONNECT_MAX_BACKOFF_MS;
    this.pollingIntervalMs = deps.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS;
  }

  async start(handler: WatcherHandler): Promise<void> {
    this.handler = handler;
    this.stopped = false;
    this.subscribeAll();
    this.connected = true;
    metrics.rpcUp.set(1);
    this.deps.logger.info(
      { contract: this.deps.paymentChannelAddress, chainId: this.deps.chainId },
      'watcher subscribed to PaymentChannel events',
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.tearDown();
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.rpcDownInterval !== undefined) {
      clearInterval(this.rpcDownInterval);
      this.rpcDownInterval = undefined;
    }
    this.handler = undefined;
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  lastEventBlockNumber(): bigint | null {
    return this.headBlock;
  }

  async __forFlush(): Promise<void> {
    await this.flushConfirmed();
  }

  private subscribeAll(): void {
    for (const name of ALL_EVENT_NAMES) {
      this.unwatches.push(this.subscribe(name));
    }
  }

  private subscribe(eventName: EventName): () => void {
    return this.publicClient.watchContractEvent({
      address: this.deps.paymentChannelAddress,
      abi: eventsAbi,
      eventName,
      pollingInterval: this.pollingIntervalMs,
      onLogs: (logs) => {
        for (const log of logs) {
          const decoded = this.decodeLog(eventName, log);
          if (!decoded) continue;
          this.pending.set(decoded.event.txHash, decoded);
        }
        void this.flushConfirmed();
      },
      onError: (err) => {
        this.handleConnectionError(err);
      },
    });
  }

  private decodeLog(
    eventName: EventName,
    log: {
      args: Record<string, unknown>;
      transactionHash: `0x${string}` | null;
      blockNumber: bigint | null;
    },
  ): PendingEntry | null {
    if (log.transactionHash === null || log.blockNumber === null) return null;
    const args = log.args;
    const channelId = args.channelId as `0x${string}` | undefined;
    if (!channelId) return null;
    const txHash = log.transactionHash;
    const blockNumber = log.blockNumber;
    let event: WatcherEvent;
    if (eventName === 'ChannelOpened') {
      event = { kind: 'open', channelId, txHash, blockNumber };
    } else if (eventName === 'ChannelClosingUnilateral') {
      const version = args.postedVersion as bigint | undefined;
      const disputeDeadline = args.disputeDeadline as bigint | undefined;
      if (version === undefined || disputeDeadline === undefined) return null;
      event = {
        kind: 'closeUnilateral',
        channelId,
        version,
        disputeDeadline,
        txHash,
        blockNumber,
      };
    } else if (eventName === 'DisputeRaised') {
      const version = args.version as bigint | undefined;
      if (version === undefined) return null;
      event = { kind: 'dispute', channelId, version, txHash, blockNumber };
    } else {
      const payA = args.payA as bigint | undefined;
      const payB = args.payB as bigint | undefined;
      if (payA === undefined || payB === undefined) return null;
      event = { kind: 'finalize', channelId, payA, payB, txHash, blockNumber };
    }
    return { event, blockNumber };
  }

  private async flushConfirmed(): Promise<void> {
    if (this.handler === undefined) return;
    let head: bigint;
    try {
      head = await this.publicClient.getBlockNumber();
    } catch (err) {
      this.deps.logger.warn({ err }, 'flushConfirmed: getBlockNumber failed');
      return;
    }
    this.headBlock = head;
    const ready: PendingEntry[] = [];
    for (const entry of this.pending.values()) {
      if (head - entry.blockNumber + 1n >= BigInt(this.confirmations)) {
        ready.push(entry);
      }
    }
    for (const entry of ready) {
      let receipt: Awaited<ReturnType<PublicClient['getTransactionReceipt']>> | null;
      try {
        receipt = await this.publicClient.getTransactionReceipt({ hash: entry.event.txHash });
      } catch (err) {
        if (isReceiptNotFound(err)) {
          this.pending.delete(entry.event.txHash);
          this.deps.logger.warn(
            { txHash: entry.event.txHash, blockNumber: entry.blockNumber },
            'watcher: dropping reorg-evicted event',
          );
        } else {
          this.deps.logger.warn(
            { err, txHash: entry.event.txHash, blockNumber: entry.blockNumber },
            'watcher: receipt fetch failed; will retry on next flush',
          );
        }
        continue;
      }
      this.pending.delete(entry.event.txHash);
      if (
        this.deps.interestedChannelIds &&
        !this.deps.interestedChannelIds.has(entry.event.channelId)
      ) {
        continue;
      }
      try {
        await this.handler(entry.event);
      } catch (err) {
        this.deps.logger.error({ err, event: entry.event }, 'watcher handler threw');
      }
    }
  }

  private handleConnectionError(err: unknown): void {
    if (this.stopped) return;
    this.deps.logger.warn({ err }, 'watcher RPC error; tearing down subscriptions');
    this.connected = false;
    metrics.rpcUp.set(0);
    this.tearDown();
    this.startRpcDownReporter();
    this.scheduleReconnect();
  }

  private tearDown(): void {
    for (const fn of this.unwatches) {
      try {
        fn();
      } catch {
        // ignore individual unwatch failures
      }
    }
    this.unwatches = [];
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer !== undefined) return;
    const exp = Math.min(this.maxBackoffMs, RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempts);
    const jitter = exp * (Math.random() * 0.2 - 0.1);
    const delay = Math.max(0, Math.floor(exp + jitter));
    this.reconnectAttempts += 1;
    this.deps.logger.info(
      { attempt: this.reconnectAttempts, delay },
      'watcher scheduling reconnect',
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.stopped || this.handler === undefined) return;
      try {
        this.subscribeAll();
        this.connected = true;
        metrics.rpcUp.set(1);
        this.reconnectAttempts = 0;
        if (this.rpcDownInterval !== undefined) {
          clearInterval(this.rpcDownInterval);
          this.rpcDownInterval = undefined;
        }
        this.deps.logger.info('watcher reconnected to RPC');
      } catch (err) {
        this.deps.logger.warn({ err }, 'watcher reconnect failed');
        this.scheduleReconnect();
      }
    }, delay);
  }

  private startRpcDownReporter(): void {
    if (this.rpcDownInterval !== undefined) return;
    this.rpcDownInterval = setInterval(() => {
      this.deps.logger.warn(
        { contract: this.deps.paymentChannelAddress, chainId: this.deps.chainId },
        'WATCHTOWER_RPC_DOWN',
      );
    }, RPC_DOWN_REPORT_INTERVAL_MS);
  }
}
