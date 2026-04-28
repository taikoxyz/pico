import type { ChannelId } from '@tainnel/protocol';
import type { FraudDetector } from './detector.js';
import type { Logger } from './logger.js';
import type { WatchtowerMetrics } from './metrics.js';
import type { CloserSide, PenaltyResponder } from './responder.js';
import type { ObservationRepo } from './storage.js';

export interface SchedulerDeps {
  readonly observationRepo: ObservationRepo;
  readonly responder: PenaltyResponder;
  readonly detector: FraudDetector;
  readonly metrics?: WatchtowerMetrics;
  readonly logger: Logger;
  readonly intervalMs?: number;
  readonly closerSide?: (channelId: ChannelId) => CloserSide;
}

const DEFAULT_INTERVAL_MS = 60_000;

export class PenaltyScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly intervalMs: number;

  constructor(private readonly deps: SchedulerDeps) {
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(): Promise<void> {
    const now = Date.now();
    const pending = this.deps.observationRepo.pendingObservations(now);
    for (const obs of pending) {
      const evidence = this.deps.detector.getLatest(obs.channelId);
      if (!evidence) {
        this.deps.logger.warn({ channelId: obs.channelId }, 'no evidence for pending observation');
        continue;
      }
      const closerSide = this.deps.closerSide ? this.deps.closerSide(obs.channelId) : 'A';
      try {
        const txHash = await this.deps.responder.submitPenalty(obs.channelId, evidence, closerSide);
        this.deps.observationRepo.markSubmitted(obs.channelId, txHash, Date.now());
        this.deps.observationRepo.markIncluded(obs.channelId, Date.now());
        this.deps.metrics?.inc('penaltiesSubmittedTotal');
      } catch (err) {
        this.deps.logger.error({ err, channelId: obs.channelId }, 'penalty submission failed');
      }
    }
  }
}
