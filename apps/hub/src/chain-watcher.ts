import type { Logger } from './logger.js';

export interface ChainWatcherDeps {
  readonly rpcUrl: string;
  readonly logger: Logger;
}

export class ChainWatcher {
  constructor(private readonly deps: ChainWatcherDeps) {}

  async start(): Promise<void> {
    this.deps.logger.info({ rpcUrl: this.deps.rpcUrl }, 'chain watcher start (stub)');
  }

  async stop(): Promise<void> {
    this.deps.logger.info('chain watcher stop (stub)');
  }
}
