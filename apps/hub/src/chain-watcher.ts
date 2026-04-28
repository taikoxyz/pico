import type { Address, ChannelId, Hex } from '@tainnel/protocol';
import { http, type Chain, type Log, type PublicClient, createPublicClient, parseAbi } from 'viem';
import { taiko, taikoHoodi } from 'viem/chains';
import type { Logger } from './logger.js';

export const PAYMENT_CHANNEL_EVENTS_ABI = parseAbi([
  'event ChannelOpened(bytes32 indexed channelId, address indexed userA, address indexed userB, address token, uint256 amountA, uint256 amountB)',
  'event ChannelClosingUnilateral(bytes32 indexed channelId, uint64 postedVersion, uint256 disputeDeadline)',
  'event DisputeRaised(bytes32 indexed channelId, uint64 challengerVersion)',
  'event ChannelFinalized(bytes32 indexed channelId, uint256 paidA, uint256 paidB)',
]);

export type ChainWatcherCallback = (event: ChainEvent) => void | Promise<void>;

export type ChainEventKind =
  | 'channelOpened'
  | 'closingUnilateral'
  | 'disputeRaised'
  | 'channelFinalized';

export interface ChainEvent {
  readonly kind: ChainEventKind;
  readonly channelId: ChannelId;
  readonly txHash: Hex;
  readonly blockNumber: bigint;
  readonly logIndex: number;
  readonly observedAtMs: number;
  readonly version?: bigint;
}

export interface ChainWatcherDeps {
  readonly rpcUrl: string;
  readonly chain: Chain;
  readonly contractAddress: Address;
  readonly logger: Logger;
  readonly client?: PublicClient;
  readonly confirmations?: number;
  readonly pollIntervalMs?: number;
  readonly channelIdFilter?: (id: ChannelId) => boolean;
}

const DEFAULT_CONFIRMATIONS = 3;
const DEFAULT_POLL_MS = 4_000;

interface PendingEvent {
  readonly event: ChainEvent;
  readonly firstSeenBlock: bigint;
}

export function chainById(chainId: number): Chain {
  if (chainId === taiko.id) return taiko;
  if (chainId === taikoHoodi.id) return taikoHoodi;
  throw new Error(`unsupported chain id ${chainId}`);
}

export class ChainWatcher {
  private readonly client: PublicClient;
  private readonly callbacks = new Map<ChainEventKind, ChainWatcherCallback[]>();
  private readonly pending = new Map<string, PendingEvent>();
  private readonly confirmations: number;
  private readonly pollMs: number;
  private unwatchers: Array<() => void> = [];
  private pollTimer: NodeJS.Timeout | undefined;
  private rpcUp = true;
  private lastBlock = 0n;
  private stopped = false;

  constructor(private readonly deps: ChainWatcherDeps) {
    this.confirmations = deps.confirmations ?? DEFAULT_CONFIRMATIONS;
    this.pollMs = deps.pollIntervalMs ?? DEFAULT_POLL_MS;
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

  on(kind: ChainEventKind, cb: ChainWatcherCallback): void {
    const list = this.callbacks.get(kind) ?? [];
    list.push(cb);
    this.callbacks.set(kind, list);
  }

  async start(): Promise<void> {
    this.stopped = false;
    const unwatch = this.client.watchContractEvent({
      address: this.deps.contractAddress,
      abi: PAYMENT_CHANNEL_EVENTS_ABI,
      onLogs: (logs) => {
        for (const log of logs) this.queue(log as Log);
        void this.advance();
      },
      onError: (err) => {
        this.rpcUp = false;
        this.deps.logger.warn({ err }, 'HUB_CHAIN_RPC_DOWN');
      },
      pollingInterval: this.pollMs,
    });
    this.unwatchers.push(unwatch);
    this.pollTimer = setInterval(() => {
      void this.advance();
    }, this.pollMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    for (const u of this.unwatchers) {
      try {
        u();
      } catch (err) {
        this.deps.logger.warn({ err }, 'unwatch failed');
      }
    }
    this.unwatchers = [];
  }

  async pingChain(): Promise<boolean> {
    try {
      this.lastBlock = await this.client.getBlockNumber();
      this.rpcUp = true;
      return true;
    } catch (err) {
      this.rpcUp = false;
      this.deps.logger.warn({ err }, 'chain ping failed');
      return false;
    }
  }

  private queue(log: Log): void {
    const event = parseLog(log);
    if (!event) return;
    if (this.deps.channelIdFilter && !this.deps.channelIdFilter(event.channelId)) return;
    const key = `${event.txHash}:${event.logIndex}`;
    if (this.pending.has(key)) return;
    this.pending.set(key, { event, firstSeenBlock: event.blockNumber });
  }

  private async advance(): Promise<void> {
    if (this.stopped) return;
    let block: bigint;
    try {
      block = await this.client.getBlockNumber();
      this.rpcUp = true;
    } catch (err) {
      this.rpcUp = false;
      this.deps.logger.warn({ err }, 'getBlockNumber failed');
      return;
    }
    this.lastBlock = block;
    const ready: ChainEvent[] = [];
    for (const [key, p] of this.pending) {
      if (block - p.firstSeenBlock >= BigInt(this.confirmations)) {
        ready.push(p.event);
        this.pending.delete(key);
      }
    }
    for (const event of ready) {
      const cbs = this.callbacks.get(event.kind);
      if (!cbs) continue;
      for (const cb of cbs) {
        try {
          await cb(event);
        } catch (err) {
          this.deps.logger.error({ err, event }, 'chain watcher callback failed');
        }
      }
    }
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

export function parseLog(log: Log): ChainEvent | undefined {
  const eventName = (log as Log & { eventName?: string }).eventName;
  const args = (log as Log & { args?: unknown }).args;
  if (!eventName || !args || typeof args !== 'object') return undefined;
  const txHash = log.transactionHash ?? ('0x' as Hex);
  const blockNumber = log.blockNumber ?? 0n;
  const logIndex = log.logIndex ?? 0;
  const observedAtMs = Date.now();
  switch (eventName) {
    case 'ChannelOpened': {
      const a = args as ChannelOpenedArgs;
      return {
        kind: 'channelOpened',
        channelId: a.channelId as ChannelId,
        txHash,
        blockNumber,
        logIndex,
        observedAtMs,
      };
    }
    case 'ChannelClosingUnilateral': {
      const a = args as ClosingArgs;
      return {
        kind: 'closingUnilateral',
        channelId: a.channelId as ChannelId,
        version: a.postedVersion,
        txHash,
        blockNumber,
        logIndex,
        observedAtMs,
      };
    }
    case 'DisputeRaised': {
      const a = args as DisputeArgs;
      return {
        kind: 'disputeRaised',
        channelId: a.channelId as ChannelId,
        version: a.challengerVersion,
        txHash,
        blockNumber,
        logIndex,
        observedAtMs,
      };
    }
    case 'ChannelFinalized': {
      void (args as FinalizedArgs);
      const a = args as FinalizedArgs;
      return {
        kind: 'channelFinalized',
        channelId: a.channelId as ChannelId,
        txHash,
        blockNumber,
        logIndex,
        observedAtMs,
      };
    }
    default:
      return undefined;
  }
}
