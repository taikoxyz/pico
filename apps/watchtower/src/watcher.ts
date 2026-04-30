import type { Address } from '@tainnel/protocol';
import { http, type Chain, type PublicClient, createPublicClient, parseAbi } from 'viem';
import { foundry, taiko } from 'viem/chains';
import type { Logger } from './logger.js';

const closingEventAbi = parseAbi([
  'event ChannelClosingUnilateral(bytes32 indexed channelId, uint64 postedVersion, uint256 disputeDeadline)',
]);

function chainForId(chainId: number): Chain {
  if (chainId === 167000) return taiko;
  return foundry;
}

export interface WatcherEvent {
  readonly kind: 'closeUnilateral' | 'dispute' | 'finalize';
  readonly channelId: `0x${string}`;
  readonly version: bigint;
  readonly txHash: `0x${string}`;
}

export type WatcherHandler = (event: WatcherEvent) => Promise<void>;

export interface ChainEventWatcherDeps {
  readonly rpcUrl: string;
  readonly paymentChannelAddress: Address;
  readonly chainId: number;
  readonly logger: Logger;
  readonly publicClient?: PublicClient;
  readonly pollingIntervalMs?: number;
}

export class ChainEventWatcher {
  private readonly publicClient: PublicClient;
  private unwatch: (() => void) | undefined;

  constructor(private readonly deps: ChainEventWatcherDeps) {
    const chain = chainForId(deps.chainId);
    this.publicClient =
      deps.publicClient ??
      (createPublicClient({
        chain,
        transport: http(deps.rpcUrl),
      }) as PublicClient);
  }

  async start(handler: WatcherHandler): Promise<void> {
    this.unwatch = this.publicClient.watchContractEvent({
      address: this.deps.paymentChannelAddress,
      abi: closingEventAbi,
      eventName: 'ChannelClosingUnilateral',
      pollingInterval: this.deps.pollingIntervalMs ?? 250,
      onLogs: (logs) => {
        for (const log of logs) {
          const channelId = log.args.channelId;
          const postedVersion = log.args.postedVersion;
          if (channelId === undefined || postedVersion === undefined) continue;
          void handler({
            kind: 'closeUnilateral',
            channelId,
            version: postedVersion,
            txHash: log.transactionHash,
          }).catch((err) => {
            this.deps.logger.error({ err }, 'watcher handler threw');
          });
        }
      },
    });
    this.deps.logger.info(
      { contract: this.deps.paymentChannelAddress, chainId: this.deps.chainId },
      'watcher subscribed to ChannelClosingUnilateral',
    );
  }

  async stop(): Promise<void> {
    if (this.unwatch) {
      this.unwatch();
      this.unwatch = undefined;
    }
  }
}
