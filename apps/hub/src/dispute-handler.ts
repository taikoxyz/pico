import type { ChannelId } from '@tainnel/protocol';
import type { Logger } from './logger.js';

export interface DisputeNotification {
  readonly channelId: ChannelId;
  readonly attackerVersion: bigint;
  readonly observedAtMs: number;
}

export class DisputeHandler {
  constructor(private readonly logger: Logger) {}

  async handle(notification: DisputeNotification): Promise<void> {
    this.logger.warn({ notification }, 'dispute observed (stub)');
    throw new Error('not implemented');
  }
}
