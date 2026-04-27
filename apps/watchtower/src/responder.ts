import type { ChannelId, SignedState } from '@tainnel/protocol';
import type { Logger } from './logger.js';

export class PenaltyResponder {
  constructor(
    private readonly rpcUrl: string,
    private readonly privateKey: string,
    private readonly logger: Logger,
  ) {}

  async submitPenalty(channelId: ChannelId, evidence: SignedState): Promise<`0x${string}`> {
    this.logger.warn({ channelId, version: evidence.state.version }, 'penalty submission (stub)');
    throw new Error('not implemented');
  }
}
