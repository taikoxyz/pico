import type { Channel, ChannelId, SignedState } from '@tainnel/protocol';
import type { ChannelRepo, StateRepo } from './db/repos.js';
import type { Logger } from './logger.js';

export class StaleStateError extends Error {
  readonly code = 'stale_state';
  constructor(channelId: ChannelId, candidateVersion: bigint, knownVersion: bigint) {
    super(
      `state for ${channelId} v=${candidateVersion} is not strictly newer than known v=${knownVersion}`,
    );
  }
}

export interface ChannelPoolDeps {
  readonly logger: Logger;
  readonly channelRepo: ChannelRepo;
  readonly stateRepo: StateRepo;
}

export class ChannelPool {
  private readonly channels = new Map<ChannelId, Channel>();
  private readonly latestState = new Map<ChannelId, SignedState>();
  private readonly locks = new Map<ChannelId, Promise<unknown>>();

  constructor(private readonly deps: ChannelPoolDeps) {}

  hydrate(): void {
    for (const c of this.deps.channelRepo.list()) {
      this.channels.set(c.id, c);
      const latest = this.deps.stateRepo.latest(c.id);
      if (latest) this.latestState.set(c.id, latest);
    }
  }

  register(channel: Channel): void {
    this.channels.set(channel.id, channel);
    this.deps.channelRepo.upsert(channel);
    this.deps.logger.info({ channelId: channel.id }, 'channel registered');
  }

  setStatus(id: ChannelId, status: Channel['status']): void {
    const existing = this.channels.get(id);
    if (!existing) return;
    const updated = { ...existing, status };
    this.channels.set(id, updated);
    this.deps.channelRepo.setStatus(id, status);
  }

  get(id: ChannelId): Channel | undefined {
    return this.channels.get(id);
  }

  list(): readonly Channel[] {
    return Array.from(this.channels.values());
  }

  size(): number {
    return this.channels.size;
  }

  recordState(channelId: ChannelId, state: SignedState): void {
    const known = this.latestState.get(channelId);
    if (known && state.state.version <= known.state.version) {
      throw new StaleStateError(channelId, state.state.version, known.state.version);
    }
    this.latestState.set(channelId, state);
    this.deps.stateRepo.record(channelId, state);
  }

  latest(channelId: ChannelId): SignedState | undefined {
    return this.latestState.get(channelId);
  }

  async withLock<T>(channelId: ChannelId, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(channelId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tracked = next.catch(() => undefined);
    this.locks.set(channelId, tracked);
    try {
      return await next;
    } finally {
      if (this.locks.get(channelId) === tracked) {
        this.locks.delete(channelId);
      }
    }
  }
}
