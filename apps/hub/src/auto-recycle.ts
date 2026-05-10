import type { ChannelId } from '@inferenceroom/pico-protocol';
import type { ChannelPool } from './channel-pool.js';
import type { Repos } from './db/repos/index.js';
import type { Logger } from './logger.js';
import type { KeyedMutex } from './mutex.js';
import { HOT_WALLET_KEY, type TopUpHandler } from './topup-handler.js';

export interface AutoRecycleDeps {
  readonly logger: Logger;
  readonly repos: Repos;
  readonly channelPool: ChannelPool;
  readonly topupHandler: TopUpHandler;
  readonly hotWalletMutex: KeyedMutex<string>;
}

export class AutoRecycle {
  constructor(private readonly deps: AutoRecycleDeps) {}

  /**
   * Triggered by chain-watcher on `ChannelClosedCooperative` (or
   * `ChannelFinalized`) where the hub recovered USDC. Walks the queued
   * top-up offers and proposes the highest-priority pending one.
   *
   * Locking strategy: `KeyedMutex` is *not* reentrant (see `mutex.ts`), and
   * `topupHandler.propose` itself acquires `HOT_WALLET_KEY`. So we do the
   * candidate selection inside the mutex (where we can read `committed` /
   * `submitted` consistently), then release before calling `propose` to
   * avoid self-deadlock.
   */
  async onClose(channelId: ChannelId, hubReceived: bigint): Promise<void> {
    if (hubReceived <= 0n) return;
    this.deps.logger.info(
      { channelId, hubReceived: hubReceived.toString() },
      'auto-recycle: triggered',
    );
    const candidate = await this.deps.hotWalletMutex.run(HOT_WALLET_KEY, async () => {
      const queued = await this.deps.repos.topupOffers.listQueued();
      // Pick the first queued row whose amount fits in the freshly recovered
      // headroom. Falls back to a partially-fundable candidate (any amount
      // ≤ hubReceived) to enable Scenario 13's "top up by 4 instead of 5" flow.
      for (const o of queued) {
        if (o.amount <= hubReceived) {
          return { offer: o, channelId: o.channelId };
        }
      }
      // No exact match — pick the smallest queued amount as a partial-fund
      // target if we have one.
      if (queued.length > 0) {
        const smallest = queued.reduce((a, b) => (a.amount <= b.amount ? a : b));
        return { offer: smallest, channelId: smallest.channelId };
      }
      return undefined;
    });

    if (!candidate) return;

    const ch = this.deps.channelPool.get(candidate.channelId);
    if (!ch) {
      this.deps.logger.warn(
        { channelId: candidate.channelId },
        'auto-recycle: candidate channel missing',
      );
      return;
    }

    // Cap the proposed amount by what just arrived (per §8.8: don't exceed
    // available headroom on auto-recycle).
    const proposedAmount =
      candidate.offer.amount <= hubReceived ? candidate.offer.amount : hubReceived;

    try {
      await this.deps.topupHandler.propose(ch, proposedAmount);
      // Mark the queued row as superseded by retiring it. We use 'rejected'
      // with a clear reason rather than introducing a new status; the queued
      // entry has done its job once a real offer is in flight.
      await this.deps.repos.topupOffers.update(candidate.offer.offerId, {
        status: 'rejected',
        rejectReason: 'superseded by auto-recycle propose',
      });
    } catch (err) {
      this.deps.logger.error(
        { err: (err as Error).message, channelId: candidate.channelId },
        'auto-recycle: propose failed',
      );
    }
  }
}
