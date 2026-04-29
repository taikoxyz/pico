import type { Address, ChannelId, Hex } from '@tainnel/protocol';
import { http, type Chain, type Log, type PublicClient, createPublicClient } from 'viem';
import { taiko, taikoHoodi } from 'viem/chains';
import { PAYMENT_CHANNEL_EVENTS_ABI } from './abi.js';
import type { Logger } from './logger.js';

export type WatcherEventKind = 'channelOpened' | 'closeUnilateral' | 'dispute' | 'finalize';

export interface WatcherEvent {
  readonly kind: WatcherEventKind;
  readonly channelId: ChannelId;
  readonly version: bigint;
  readonly txHash: Hex;
  readonly logIndex: number;
  readonly blockNumber: bigint;
  readonly observedAtMs: number;
}

export type WatcherHandler = (event: WatcherEvent) => Promise<void> | void;

export interface ChainEventWatcherDeps {
  readonly rpcUrl: string;
  readonly chain: Chain;
  readonly contractAddress: Address;
  readonly logger: Logger;
  readonly client?: PublicClient;
  readonly confirmations?: number;
  readonly pollIntervalMs?: number;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly rpcDownLogIntervalMs?: number;
  readonly interestedChannelIds?: ReadonlySet<ChannelId>;
}

interface PendingEvent {
  readonly event: WatcherEvent;
  readonly firstSeenBlock: bigint;
}

const DEFAULT_CONFIRMATIONS = 3;
const DEFAULT_POLL_MS = 4_000;
const DEFAULT_INITIAL_BACKOFF_MS = 200;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_RPC_DOWN_LOG_MS = 5 * 60 * 1000;

export function chainById(chainId: number): Chain {
  if (chainId === taiko.id) return taiko;
  if (chainId === taikoHoodi.id) return taikoHoodi;
  throw new Error(`unsupported chain id ${chainId}`);
}

export class ChainEventWatcher {
  private readonly client: PublicClient;
  private readonly confirmations: number;
  private readonly pollMs: number;
  private readonly pending = new Map<string, PendingEvent>();
  private unwatchers: Array<() => void> = [];
  private rpcDownTimer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private resubscribeTimer: NodeJS.Timeout | undefined;
  private rpcUp = true;
  private backoffMs: number;
  private stopped = false;
  private lastRpcDownLogAt = 0;
  private lastBlock = 0n;

  constructor(private readonly deps: ChainEventWatcherDeps) {
    this.confirmations = deps.confirmations ?? DEFAULT_CONFIRMATIONS;
    this.pollMs = deps.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.backoffMs = deps.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.client =
      deps.client ??
      (createPublicClient({
        chain: deps.chain,
        transport: http(deps.rpcUrl),
      }) as unknown as PublicClient);
  }

  isRpcUp(): boolean {
    return this.rpcUp;
  }

  getLastBlock(): bigint {
    return this.lastBlock;
  }

  async start(handler: WatcherHandler): Promise<void> {
    this.stopped = false;
    await this.subscribe(handler);
    this.pollTimer = setInterval(() => {
      void this.advance(handler);
    }, this.pollMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.rpcDownTimer) {
      clearInterval(this.rpcDownTimer);
      this.rpcDownTimer = undefined;
    }
    if (this.resubscribeTimer) {
      clearTimeout(this.resubscribeTimer);
      this.resubscribeTimer = undefined;
    }
    this.disposeUnwatchers();
  }

  private disposeUnwatchers(): void {
    for (const u of this.unwatchers) {
      try {
        u();
      } catch (err) {
        this.deps.logger.warn({ err }, 'unwatch failed');
      }
    }
    this.unwatchers = [];
  }

  private async subscribe(handler: WatcherHandler): Promise<void> {
    const unwatch = this.client.watchContractEvent({
      address: this.deps.contractAddress,
      abi: PAYMENT_CHANNEL_EVENTS_ABI,
      onLogs: (logs) => {
        for (const log of logs) this.queue(log as Log);
        void this.advance(handler);
      },
      onError: (err) => {
        this.handleRpcError(err, handler);
      },
      pollingInterval: this.pollMs,
    });
    this.unwatchers.push(unwatch);
    this.markUp();
  }

  private queue(log: Log): void {
    const event = parseLog(log);
    if (!event) return;
    if (this.deps.interestedChannelIds && !this.deps.interestedChannelIds.has(event.channelId)) {
      return;
    }
    const key = `${event.txHash}:${event.logIndex}`;
    if (this.pending.has(key)) return;
    this.pending.set(key, {
      event,
      firstSeenBlock: event.blockNumber,
    });
  }

  private async advance(handler: WatcherHandler): Promise<void> {
    if (this.stopped) return;
    let currentBlock: bigint;
    try {
      currentBlock = await this.client.getBlockNumber();
      this.markUp();
    } catch (err) {
      this.handleRpcError(err, handler);
      return;
    }
    this.lastBlock = currentBlock;
    const ready: Array<{ key: string; event: WatcherEvent }> = [];
    for (const [key, pending] of this.pending) {
      if (currentBlock - pending.firstSeenBlock >= BigInt(this.confirmations)) {
        ready.push({ key, event: pending.event });
      }
    }
    for (const { key, event } of ready) {
      this.pending.delete(key);
      try {
        await handler(event);
      } catch (err) {
        this.deps.logger.error({ err, event }, 'watcher handler failed');
      }
    }
  }

  private handleRpcError(err: unknown, handler: WatcherHandler): void {
    if (this.stopped) return;
    if (this.rpcUp) {
      this.rpcUp = false;
      this.lastRpcDownLogAt = Date.now();
      this.deps.logger.warn({ err }, 'WATCHTOWER_RPC_DOWN');
    } else {
      const interval = this.deps.rpcDownLogIntervalMs ?? DEFAULT_RPC_DOWN_LOG_MS;
      const now = Date.now();
      if (now - this.lastRpcDownLogAt >= interval) {
        this.lastRpcDownLogAt = now;
        this.deps.logger.warn({ err }, 'WATCHTOWER_RPC_DOWN');
      }
    }
    if (this.resubscribeTimer) return;
    this.resubscribeTimer = setTimeout(() => {
      this.resubscribeTimer = undefined;
      if (this.stopped) return;
      this.disposeUnwatchers();
      void this.subscribe(handler).catch((subErr) => {
        this.handleRpcError(subErr, handler);
      });
    }, this.backoffMs);
    const max = this.deps.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.backoffMs = Math.min(max, this.backoffMs * 2);
  }

  private markUp(): void {
    if (!this.rpcUp) {
      this.deps.logger.info('WATCHTOWER_RPC_UP');
    }
    this.rpcUp = true;
    this.backoffMs = this.deps.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  }
}

interface ChannelOpenedArgs {
  channelId: Hex;
  userA: Address;
  userB: Address;
  token: Address;
  amountA: bigint;
  amountB: bigint;
}

interface ClosingArgs {
  channelId: Hex;
  postedVersion: bigint;
  disputeDeadline: bigint;
}

interface DisputeArgs {
  channelId: Hex;
  challengerVersion: bigint;
}

interface FinalizedArgs {
  channelId: Hex;
  paidA: bigint;
  paidB: bigint;
}

export function parseLog(log: Log): WatcherEvent | undefined {
  const eventName = (log as Log & { eventName?: string }).eventName;
  const args = (log as Log & { args?: unknown }).args;
  if (!eventName || !args || typeof args !== 'object') return undefined;
  const blockNumber = log.blockNumber ?? 0n;
  const txHash = log.transactionHash ?? ('0x' as Hex);
  const logIndex = log.logIndex ?? 0;
  const observedAtMs = Date.now();
  switch (eventName) {
    case 'ChannelOpened': {
      const a = args as ChannelOpenedArgs;
      return {
        kind: 'channelOpened',
        channelId: a.channelId as ChannelId,
        version: 0n,
        txHash,
        logIndex,
        blockNumber,
        observedAtMs,
      };
    }
    case 'ChannelClosingUnilateral': {
      const a = args as ClosingArgs;
      return {
        kind: 'closeUnilateral',
        channelId: a.channelId as ChannelId,
        version: a.postedVersion,
        txHash,
        logIndex,
        blockNumber,
        observedAtMs,
      };
    }
    case 'DisputeRaised': {
      const a = args as DisputeArgs;
      return {
        kind: 'dispute',
        channelId: a.channelId as ChannelId,
        version: a.challengerVersion,
        txHash,
        logIndex,
        blockNumber,
        observedAtMs,
      };
    }
    case 'ChannelFinalized': {
      const a = args as FinalizedArgs;
      return {
        kind: 'finalize',
        channelId: a.channelId as ChannelId,
        version: 0n,
        txHash,
        logIndex,
        blockNumber,
        observedAtMs,
      };
    }
    default:
      return undefined;
  }
}
