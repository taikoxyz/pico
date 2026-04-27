import type { Logger } from './logger.js';

export interface WatcherEvent {
  readonly kind: 'closeUnilateral' | 'dispute' | 'finalize';
  readonly channelId: `0x${string}`;
  readonly version: bigint;
  readonly txHash: `0x${string}`;
}

export type WatcherHandler = (event: WatcherEvent) => Promise<void>;

export class ChainEventWatcher {
  constructor(
    private readonly rpcUrl: string,
    private readonly logger: Logger,
  ) {}

  async start(_handler: WatcherHandler): Promise<void> {
    this.logger.info({ rpcUrl: this.rpcUrl }, 'watcher start (stub)');
  }

  async stop(): Promise<void> {
    this.logger.info('watcher stop (stub)');
  }
}
