import type { ChannelId } from '@tainnel/protocol';
import type { HtlcRepo } from './db/repos.js';

export interface LiquiditySnapshot {
  readonly inbound: bigint;
  readonly outbound: bigint;
  readonly reserved: bigint;
}

export class InsufficientLiquidityError extends Error {
  readonly code = 'insufficient_liquidity';
  constructor(channelId: ChannelId, requested: bigint, available: bigint) {
    super(`channel ${channelId}: requested ${requested} > available ${available}`);
  }
}

export class LiquidityTracker {
  private readonly state = new Map<ChannelId, LiquiditySnapshot>();

  set(
    channelId: ChannelId,
    snapshot: Omit<LiquiditySnapshot, 'reserved'> & { reserved?: bigint },
  ): void {
    this.state.set(channelId, {
      inbound: snapshot.inbound,
      outbound: snapshot.outbound,
      reserved: snapshot.reserved ?? 0n,
    });
  }

  get(channelId: ChannelId): LiquiditySnapshot | undefined {
    return this.state.get(channelId);
  }

  availableOutbound(channelId: ChannelId): bigint {
    const s = this.state.get(channelId);
    if (!s) return 0n;
    return s.outbound - s.reserved;
  }

  reserveOutbound(channelId: ChannelId, amount: bigint): void {
    const s = this.state.get(channelId);
    if (!s) throw new InsufficientLiquidityError(channelId, amount, 0n);
    if (amount > s.outbound - s.reserved) {
      throw new InsufficientLiquidityError(channelId, amount, s.outbound - s.reserved);
    }
    this.state.set(channelId, { ...s, reserved: s.reserved + amount });
  }

  releaseReservation(channelId: ChannelId, amount: bigint): void {
    const s = this.state.get(channelId);
    if (!s) return;
    const next = s.reserved - amount;
    this.state.set(channelId, { ...s, reserved: next < 0n ? 0n : next });
  }

  hydrateFromHtlcs(channelId: ChannelId, htlcRepo: HtlcRepo): void {
    const s = this.state.get(channelId);
    if (!s) return;
    let pending = 0n;
    for (const h of htlcRepo.pendingByChannel(channelId)) {
      pending += h.amount;
    }
    this.state.set(channelId, { ...s, reserved: pending });
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
