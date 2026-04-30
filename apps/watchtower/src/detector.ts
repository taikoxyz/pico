import type { ChannelId, SignedState } from '@tainnel/protocol';
import { isStrictlyNewer } from '@tainnel/state-machine';

export interface DetectionResult {
  readonly fraudulent: boolean;
  readonly latestKnownVersion: bigint;
}

export class FraudDetector {
  private readonly latest = new Map<ChannelId, SignedState>();

  remember(state: SignedState): void {
    const existing = this.latest.get(state.state.channelId);
    if (!existing || isStrictlyNewer(state.state, existing.state)) {
      this.latest.set(state.state.channelId, state);
    }
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
}
