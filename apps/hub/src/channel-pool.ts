import type { Channel, ChannelId, SignedState } from '@tainnel/protocol';
import type { Logger } from './logger.js';

export interface ChannelPoolDeps {
  readonly logger: Logger;
}

export class ChannelPool {
  private readonly channels = new Map<ChannelId, Channel>();
  private readonly latestState = new Map<ChannelId, SignedState>();

  constructor(private readonly deps: ChannelPoolDeps) {}

  register(channel: Channel): void {
    this.channels.set(channel.id, channel);
    this.deps.logger.info({ channelId: channel.id }, 'channel registered');
  }

  get(id: ChannelId): Channel | undefined {
    return this.channels.get(id);
  }

  list(): readonly Channel[] {
    return Array.from(this.channels.values());
  }

  recordState(channelId: ChannelId, state: SignedState): void {
    this.latestState.set(channelId, state);
  }

  latest(channelId: ChannelId): SignedState | undefined {
    return this.latestState.get(channelId);
  }
}
