import type { ChannelId, SignedState } from '@tainnel/protocol';
import { isStrictlyNewer } from '@tainnel/state-machine';
import type { PlainStateStore } from './storage.js';

export interface DetectionResult {
  readonly fraudulent: boolean;
  readonly latestKnownVersion: bigint;
}

export interface EvaluateClosingOpts {
  readonly windowMs: number;
  readonly threshold: number;
}

export type EvaluateClosingResult =
  | { readonly action: 'noop'; readonly reason: string }
  | {
      readonly action: 'penalize';
      readonly evidence: SignedState;
      readonly submitBy: number;
    };

export interface FraudDetectorDeps {
  readonly stateStore?: PlainStateStore;
}

export class FraudDetector {
  private readonly latest = new Map<ChannelId, SignedState>();

  constructor(private readonly deps: FraudDetectorDeps = {}) {}

  async hydrate(): Promise<void> {
    if (!this.deps.stateStore) return;
    const all = await this.deps.stateStore.list();
    for (const s of all) {
      const existing = this.latest.get(s.state.channelId);
      if (!existing || isStrictlyNewer(s.state, existing.state)) {
        this.latest.set(s.state.channelId, s);
      }
    }
  }

  remember(state: SignedState): void {
    const existing = this.latest.get(state.state.channelId);
    if (!existing || isStrictlyNewer(state.state, existing.state)) {
      this.latest.set(state.state.channelId, state);
      void this.deps.stateStore?.put(state);
    }
  }

  evaluate(channelId: ChannelId, observedVersion: bigint): DetectionResult {
    const known = this.latest.get(channelId);
    if (!known) return { fraudulent: false, latestKnownVersion: 0n };
    return {
      fraudulent: known.state.version > observedVersion,
      latestKnownVersion: known.state.version,
    };
  }

  evaluateClosing(
    channelId: ChannelId,
    postedVersion: bigint,
    postedAt: number,
    opts: EvaluateClosingOpts,
  ): EvaluateClosingResult {
    const known = this.latest.get(channelId);
    if (!known) return { action: 'noop', reason: 'unknown channel' };
    if (known.state.version <= postedVersion) {
      return { action: 'noop', reason: 'our state is not newer' };
    }
    const submitBy = postedAt + Math.floor(opts.windowMs * opts.threshold);
    return { action: 'penalize', evidence: known, submitBy };
  }

  channelsWatched(): number {
    return this.latest.size;
  }

  knownVersion(channelId: ChannelId): bigint | undefined {
    return this.latest.get(channelId)?.state.version;
  }

  getLatest(channelId: ChannelId): SignedState | undefined {
    return this.latest.get(channelId);
  }
}
