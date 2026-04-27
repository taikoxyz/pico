import type { ChannelId } from '@tainnel/protocol';

export interface LiquiditySnapshot {
  readonly inbound: bigint;
  readonly outbound: bigint;
}

export class LiquidityTracker {
  private readonly state = new Map<ChannelId, LiquiditySnapshot>();

  set(channelId: ChannelId, snapshot: LiquiditySnapshot): void {
    this.state.set(channelId, snapshot);
  }

  get(channelId: ChannelId): LiquiditySnapshot | undefined {
    return this.state.get(channelId);
  }

  totalInbound(): bigint {
    let total = 0n;
    for (const snap of this.state.values()) total += snap.inbound;
    return total;
  }

  totalOutbound(): bigint {
    let total = 0n;
    for (const snap of this.state.values()) total += snap.outbound;
    return total;
  }
}
