import type { Address, Channel, ChannelId } from '@inferenceroom/pico-protocol';
import type { ChainAdapter } from '@inferenceroom/pico-sdk';
import type { ChannelPool } from './channel-pool.js';
import type { ChannelRepo } from './db/repos/index.js';
import type { Logger } from './logger.js';
import type { HubMetrics } from './metrics.js';
import type { KeyedMutex } from './mutex.js';
import { HOT_WALLET_KEY } from './topup-handler.js';

export interface AutoCloseSweeperDeps {
  readonly logger: Logger;
  readonly channelPool: ChannelPool;
  readonly channelRepo: ChannelRepo;
  readonly chain: ChainAdapter;
  readonly hubAddress: Address;
  readonly hotWalletMutex: KeyedMutex<string>;
  readonly metrics: HubMetrics;
  /** Idle threshold (ms since last co-signed state) before a channel is closed. */
  readonly afterMs: number;
  /** Sweep cadence (ms). */
  readonly intervalMs: number;
  /** Reads the on-chain dispute deadline (ms epoch) for a channel; 0 if none. */
  readonly readDisputeDeadlineMs: (channelId: ChannelId) => Promise<number>;
  /** Injectable clock for tests. */
  readonly now?: () => number;
}

/**
 * Periodically closes channels the hub is a party to that have seen no payment
 * (no new co-signed state) for `afterMs`. Because an idle counterparty is
 * likely offline, cooperative close is not viable, so the hub posts the latest
 * co-signed state on-chain (`closeUnilateral`) — or `closeUnilateralFromOpen`
 * for never-used channels — and finalizes once the dispute window elapses.
 *
 * Modeled on the chain-watcher's recursive-`setTimeout` loop so sweeps never
 * overlap. On-chain txs serialize with top-ups/auto-recycle via the shared
 * hot-wallet mutex to avoid nonce collisions.
 */
export class AutoCloseSweeper {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly deps: AutoCloseSweeperDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    this.stopped = false;
    this.scheduleNext();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.sweepOnce().finally(() => this.scheduleNext());
    }, this.deps.intervalMs);
    this.timer.unref?.();
  }

  private hubSideOf(channel: Channel): 'A' | 'B' | undefined {
    const hub = this.deps.hubAddress.toLowerCase();
    if (channel.userA.toLowerCase() === hub) return 'A';
    if (channel.userB.toLowerCase() === hub) return 'B';
    return undefined;
  }

  async sweepOnce(): Promise<void> {
    await this.initiatePhase();
    await this.finalizePhase();
  }

  private async initiatePhase(): Promise<void> {
    const cutoff = this.now() - this.deps.afterMs;
    let idle: readonly Channel[];
    try {
      idle = await this.deps.channelRepo.listIdleOpen(cutoff);
    } catch (err) {
      this.deps.logger.error({ err: (err as Error).message }, 'auto-close: listIdleOpen failed');
      this.deps.metrics.autoCloseErrorsTotal.inc({ phase: 'initiate' });
      return;
    }
    for (const channel of idle) {
      const side = this.hubSideOf(channel);
      if (!side) continue;
      const latest = this.deps.channelPool.latest(channel.id);
      if (!latest) continue;
      if (latest.state.htlcs.length > 0) {
        this.deps.logger.warn(
          { channelId: channel.id, htlcs: latest.state.htlcs.length },
          'auto-close: skipping idle channel with in-flight HTLCs',
        );
        continue;
      }
      try {
        await this.deps.hotWalletMutex.run(HOT_WALLET_KEY, async () => {
          if (latest.state.version === 0n) {
            await this.deps.chain.closeUnilateralFromOpen({ channelId: channel.id });
            this.deps.metrics.autoCloseInitiatedTotal.inc({ result: 'from_open' });
          } else {
            await this.deps.chain.closeUnilateral({
              channelId: channel.id,
              state: latest,
              mySide: side,
            });
            this.deps.metrics.autoCloseInitiatedTotal.inc({ result: 'unilateral' });
          }
        });
        // Optimistically mark closing so the next sweep skips it; the
        // chain-watcher sets the same status when it observes the event.
        await this.deps.channelPool.setStatus(channel.id, 'closing-unilateral');
        this.deps.logger.info(
          { channelId: channel.id, version: latest.state.version.toString() },
          'auto-close: initiated unilateral close on idle channel',
        );
      } catch (err) {
        this.deps.logger.error(
          { err: (err as Error).message, channelId: channel.id },
          'auto-close: failed to initiate close',
        );
        this.deps.metrics.autoCloseErrorsTotal.inc({ phase: 'initiate' });
      }
    }
  }

  private async finalizePhase(): Promise<void> {
    const closing = this.deps.channelPool
      .list()
      .filter((c) => c.status === 'closing-unilateral' && this.hubSideOf(c) !== undefined);
    for (const channel of closing) {
      try {
        const deadlineMs = await this.deps.readDisputeDeadlineMs(channel.id);
        if (deadlineMs <= 0 || this.now() < deadlineMs) continue;
        await this.deps.hotWalletMutex.run(HOT_WALLET_KEY, async () => {
          await this.deps.chain.finalize(channel.id);
        });
        this.deps.metrics.autoCloseFinalizedTotal.inc();
        this.deps.logger.info(
          { channelId: channel.id },
          'auto-close: finalized channel after dispute window',
        );
      } catch (err) {
        this.deps.logger.error(
          { err: (err as Error).message, channelId: channel.id },
          'auto-close: failed to finalize',
        );
        this.deps.metrics.autoCloseErrorsTotal.inc({ phase: 'finalize' });
      }
    }
  }
}
