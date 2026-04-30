import type { ChannelId } from '@tainnel/protocol';
import type { HtlcRepo } from './db/repos/index.js';

export interface LiquiditySnapshot {
  readonly inbound: bigint;
  readonly outbound: bigint;
}

export class InsufficientLiquidityError extends Error {
  readonly code = 'INSUFFICIENT_LIQUIDITY';
  constructor(channelId: ChannelId, requested: bigint, available: bigint) {
    super(`channel ${channelId} cannot reserve ${requested}; available outbound ${available}`);
    this.name = 'InsufficientLiquidityError';
  }
}

export class LiquidityTracker {
  private readonly state = new Map<ChannelId, LiquiditySnapshot>();
  private readonly reservations = new Map<ChannelId, bigint>();

  set(channelId: ChannelId, snapshot: LiquiditySnapshot): void {
    this.state.set(channelId, snapshot);
  }

  get(channelId: ChannelId): LiquiditySnapshot | undefined {
    return this.state.get(channelId);
  }

  reservedOutbound(channelId: ChannelId): bigint {
    return this.reservations.get(channelId) ?? 0n;
  }

  availableOutbound(channelId: ChannelId): bigint {
    const snap = this.state.get(channelId);
    if (!snap) return 0n;
    return snap.outbound - this.reservedOutbound(channelId);
  }

  reserveOutbound(channelId: ChannelId, amount: bigint): void {
    if (amount <= 0n) return;
    const available = this.availableOutbound(channelId);
    if (available < amount) {
      throw new InsufficientLiquidityError(channelId, amount, available);
    }
    this.reservations.set(channelId, this.reservedOutbound(channelId) + amount);
  }

  releaseReservation(channelId: ChannelId, amount: bigint): void {
    if (amount <= 0n) return;
    const current = this.reservedOutbound(channelId);
    const next = current - amount;
    if (next <= 0n) {
      this.reservations.delete(channelId);
    } else {
      this.reservations.set(channelId, next);
    }
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

  totalReserved(): bigint {
    let total = 0n;
    for (const r of this.reservations.values()) total += r;
    return total;
  }

  async hydrate(htlcRepo: HtlcRepo): Promise<void> {
    this.reservations.clear();
    const inflight = await htlcRepo.listInflight();
    for (const r of inflight) {
      if (!r.outgoingChannelId) continue;
      if (r.channelId !== r.outgoingChannelId) continue;
      const cur = this.reservations.get(r.outgoingChannelId) ?? 0n;
      this.reservations.set(r.outgoingChannelId, cur + r.htlc.amount);
    }
  }
}
