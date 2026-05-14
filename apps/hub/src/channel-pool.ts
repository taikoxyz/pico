import type { Channel, ChannelId, ChannelStatus, SignedState } from '@inferenceroom/pico-protocol';
import type { ChannelAmounts, ChannelRepo, StateRepo } from './db/repos/index.js';
import type { Logger } from './logger.js';
import { KeyedMutex } from './mutex.js';

export interface ChannelPoolDeps {
  readonly logger: Logger;
  readonly channelRepo: ChannelRepo;
  readonly stateRepo: StateRepo;
}

export class ChannelPool {
  private readonly channels = new Map<ChannelId, Channel>();
  private readonly amounts = new Map<ChannelId, ChannelAmounts>();
  private readonly latestState = new Map<ChannelId, SignedState>();
  private readonly locks = new KeyedMutex<ChannelId>();

  constructor(private readonly deps: ChannelPoolDeps) {}

  async hydrate(): Promise<void> {
    const channels = await this.deps.channelRepo.list();
    for (const ch of channels) {
      this.channels.set(ch.id, ch);
      const amts = await this.deps.channelRepo.getAmounts(ch.id);
      if (amts) this.amounts.set(ch.id, amts);
    }
    const states = await this.deps.stateRepo.loadAllLatest();
    for (const [id, st] of states) this.latestState.set(id, st);
    this.deps.logger.info(
      { channels: channels.length, states: states.size },
      'channel-pool hydrated',
    );
  }

  async register(
    channel: Channel,
    initialState?: SignedState,
    amounts?: ChannelAmounts,
  ): Promise<void> {
    await this.locks.run(channel.id, async () => {
      await this.deps.channelRepo.upsert(channel, amounts);
      this.channels.set(channel.id, channel);
      if (amounts) this.amounts.set(channel.id, amounts);
      if (initialState) {
        const existing = this.latestState.get(channel.id);
        if (!existing || initialState.state.version > existing.state.version) {
          await this.deps.stateRepo.save(initialState);
          this.latestState.set(channel.id, initialState);
        }
      }
      this.deps.logger.info({ channelId: channel.id }, 'channel registered');
    });
  }

  async setStatus(channelId: ChannelId, status: ChannelStatus): Promise<void> {
    await this.locks.run(channelId, async () => {
      const existing = this.channels.get(channelId);
      if (!existing) return;
      await this.deps.channelRepo.setStatus(channelId, status);
      this.channels.set(channelId, { ...existing, status });
    });
  }

  async recordState(channelId: ChannelId, state: SignedState): Promise<void> {
    await this.locks.run(channelId, async () => {
      const existing = this.latestState.get(channelId);
      if (existing && state.state.version <= existing.state.version) return;
      await this.deps.stateRepo.save(state);
      this.latestState.set(channelId, state);
    });
  }

  /**
   * R-02 (PR #127): Update the in-memory latest-state cache without writing
   * to the DB. Use this when the caller has already persisted the state
   * inside its own DB transaction (e.g. handlePay persists outgoingHubSigned
   * + htlcs + payments + payment_routes atomically). The lock is still taken
   * so concurrent readers see a consistent view.
   */
  async recordStateMemoryOnly(channelId: ChannelId, state: SignedState): Promise<void> {
    await this.locks.run(channelId, async () => {
      const existing = this.latestState.get(channelId);
      if (existing && state.state.version <= existing.state.version) return;
      this.latestState.set(channelId, state);
    });
  }

  /**
   * Persist a channel's on-chain `amountA` / `amountB` after a top-up
   * (§8). Caller is responsible for ensuring concurrency control via the
   * hot-wallet mutex; this method only persists and updates the in-memory
   * cache.
   */
  async updateAmounts(channelId: ChannelId, amountA: bigint, amountB: bigint): Promise<void> {
    await this.locks.run(channelId, async () => {
      const existing = this.channels.get(channelId);
      if (!existing) return;
      await this.deps.channelRepo.updateAmounts(channelId, amountA, amountB);
      this.amounts.set(channelId, { amountA, amountB });
    });
  }

  withLock<T>(channelId: ChannelId, fn: () => Promise<T>): Promise<T> {
    return this.locks.run(channelId, fn);
  }

  get(id: ChannelId): Channel | undefined {
    return this.channels.get(id);
  }

  list(): readonly Channel[] {
    return Array.from(this.channels.values());
  }

  latest(channelId: ChannelId): SignedState | undefined {
    return this.latestState.get(channelId);
  }

  /** Returns the cached on-chain amounts, or `undefined` if unknown. */
  amountsOf(channelId: ChannelId): ChannelAmounts | undefined {
    return this.amounts.get(channelId);
  }
}
