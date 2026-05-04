import type { ChannelId, SignedState } from '@pico/protocol';
import { isStrictlyNewer } from '@pico/state-machine';

export interface DetectionResult {
  readonly fraudulent: boolean;
  readonly latestKnownVersion: bigint;
}

export interface EvaluateClosingArgs {
  readonly channelId: ChannelId;
  readonly postedVersion: bigint;
  readonly postedAtMs: number;
  readonly windowMs: number;
  readonly thresholdRatio?: number;
  readonly alreadyPenalized?: boolean;
}

export type EvaluateClosingResult =
  | {
      readonly action: 'noop';
      readonly reason: 'unknown_channel' | 'not_stale' | 'already_penalized';
      readonly latestKnownVersion: bigint;
    }
  | {
      readonly action: 'penalize';
      readonly evidence: SignedState;
      readonly submitByMs: number;
      readonly latestKnownVersion: bigint;
    };

export class FraudDetector {
  private readonly latest = new Map<ChannelId, SignedState>();

  remember(state: SignedState): void {
    const existing = this.latest.get(state.state.channelId);
    if (!existing || isStrictlyNewer(state.state, existing.state)) {
      this.latest.set(state.state.channelId, state);
    }
  }

  hydrate(states: readonly SignedState[]): void {
    for (const s of states) this.remember(s);
  }

  getLatest(channelId: ChannelId): SignedState | undefined {
    return this.latest.get(channelId);
  }

  evaluate(channelId: ChannelId, observedVersion: bigint): DetectionResult {
    const known = this.latest.get(channelId);
    if (!known) return { fraudulent: false, latestKnownVersion: 0n };
    return {
      fraudulent: known.state.version > observedVersion,
      latestKnownVersion: known.state.version,
    };
  }

  evaluateClosing(args: EvaluateClosingArgs): EvaluateClosingResult {
    const {
      channelId,
      postedVersion,
      postedAtMs,
      windowMs,
      thresholdRatio = 0.5,
      alreadyPenalized = false,
    } = args;
    const known = this.latest.get(channelId);
    if (alreadyPenalized) {
      return {
        action: 'noop',
        reason: 'already_penalized',
        latestKnownVersion: known?.state.version ?? 0n,
      };
    }
    if (!known) {
      return { action: 'noop', reason: 'unknown_channel', latestKnownVersion: 0n };
    }
    if (known.state.version <= postedVersion) {
      return {
        action: 'noop',
        reason: 'not_stale',
        latestKnownVersion: known.state.version,
      };
    }
    return {
      action: 'penalize',
      evidence: known,
      submitByMs: postedAtMs + Math.floor(windowMs * thresholdRatio),
      latestKnownVersion: known.state.version,
    };
  }
}
