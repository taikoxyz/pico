import type { Channel, ChannelId, SignedState } from '@tainnel/protocol';

export interface ChannelStorage {
  saveChannel(channel: Channel): Promise<void>;
  loadChannel(id: ChannelId): Promise<Channel | undefined>;
  saveState(channelId: ChannelId, state: SignedState): Promise<void>;
  loadLatestState(channelId: ChannelId): Promise<SignedState | undefined>;
  list(): Promise<readonly Channel[]>;
}

export class MemoryStorage implements ChannelStorage {
  private readonly channels = new Map<ChannelId, Channel>();
  private readonly states = new Map<ChannelId, SignedState>();

  async saveChannel(channel: Channel): Promise<void> {
    this.channels.set(channel.id, channel);
  }
  async loadChannel(id: ChannelId): Promise<Channel | undefined> {
    return this.channels.get(id);
  }
  async saveState(channelId: ChannelId, state: SignedState): Promise<void> {
    this.states.set(channelId, state);
  }
  async loadLatestState(channelId: ChannelId): Promise<SignedState | undefined> {
    return this.states.get(channelId);
  }
  async list(): Promise<readonly Channel[]> {
    return Array.from(this.channels.values());
  }
}
